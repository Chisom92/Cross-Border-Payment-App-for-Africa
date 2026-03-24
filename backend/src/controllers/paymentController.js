const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { sendPayment } = require('../services/stellar');

// Basic fraud check: block if >5 transactions in last 10 minutes
async function fraudCheck(walletAddress) {
  const result = await db.query(
    `SELECT COUNT(*) FROM transactions
     WHERE sender_wallet = $1 AND created_at > NOW() - INTERVAL '10 minutes'`,
    [walletAddress]
  );
  return parseInt(result.rows[0].count) >= 5;
}

async function send(req, res, next) {
  try {
    const { recipient_address, amount, asset = 'XLM', memo } = req.body;

    // Get sender wallet
    const walletResult = await db.query(
      'SELECT public_key, encrypted_secret_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    const { public_key, encrypted_secret_key } = walletResult.rows[0];

    // Fraud protection
    const isSuspicious = await fraudCheck(public_key);
    if (isSuspicious) {
      return res.status(429).json({ error: 'Transaction limit reached. Please wait before sending again.' });
    }

    // Broadcast to Stellar
    const { transactionHash, ledger } = await sendPayment({
      senderPublicKey: public_key,
      encryptedSecretKey: encrypted_secret_key,
      recipientPublicKey: recipient_address,
      amount,
      asset,
      memo
    });

    // Save to DB
    const txId = uuidv4();
    await db.query(
      `INSERT INTO transactions (id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'completed')`,
      [txId, public_key, recipient_address, amount, asset, memo || null, transactionHash]
    );

    res.json({
      message: 'Payment sent successfully',
      transaction: {
        id: txId,
        tx_hash: transactionHash,
        ledger,
        amount,
        asset,
        recipient: recipient_address
      }
    });
  } catch (err) {
    if (err.status === 400 || err.status === 500) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err.response?.data) {
      const extras = err.response.data?.extras;
      return res.status(400).json({ error: 'Transaction failed', details: extras });
    }
    next(err);
  }
}

async function history(req, res, next) {
  try {
    const walletResult = await db.query(
      'SELECT public_key FROM wallets WHERE user_id = $1',
      [req.user.userId]
    );
    if (!walletResult.rows[0]) return res.status(404).json({ error: 'Wallet not found' });

    const { public_key } = walletResult.rows[0];
    const result = await db.query(
      `SELECT id, sender_wallet, recipient_wallet, amount, asset, memo, tx_hash, status, created_at
       FROM transactions
       WHERE sender_wallet = $1 OR recipient_wallet = $1
       ORDER BY created_at DESC LIMIT 50`,
      [public_key]
    );

    const transactions = result.rows.map(tx => ({
      ...tx,
      direction: tx.sender_wallet === public_key ? 'sent' : 'received'
    }));

    res.json({ transactions });
  } catch (err) {
    next(err);
  }
}

module.exports = { send, history };
