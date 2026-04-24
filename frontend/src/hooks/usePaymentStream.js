import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';

const BACKEND_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000';

/**
 * Hook to stream real-time payment events via Socket.IO (backed by Horizon streaming).
 * Falls back gracefully if the socket cannot connect.
 *
 * @param {string} publicKey - The account public key to monitor
 * @param {Function} onPayment - Callback when a payment:received event fires
 * @returns {{ isConnected: boolean, error: string|null }}
 */
export function usePaymentStream(publicKey, onPayment) {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState(null);
  const socketRef = useRef(null);
  const onPaymentRef = useRef(onPayment);

  // Keep callback ref fresh without re-connecting
  useEffect(() => {
    onPaymentRef.current = onPayment;
  }, [onPayment]);

  const getToken = useCallback(() => {
    return localStorage.getItem('token') || sessionStorage.getItem('token') || null;
  }, []);

  useEffect(() => {
    if (!publicKey) return;

    const token = getToken();
    if (!token) return;

    const socket = io(BACKEND_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      setError(null);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('connect_error', (err) => {
      setError(err.message);
      setIsConnected(false);
    });

    socket.on('payment:received', (data) => {
      if (data.to === publicKey && onPaymentRef.current) {
        onPaymentRef.current(data);
      }
    });

    socket.on('payment:confirmed', (data) => {
      if (data.account === publicKey && onPaymentRef.current) {
        onPaymentRef.current({ ...data, type: 'confirmed' });
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [publicKey, getToken]);

  return { isConnected, error };
}

export default usePaymentStream;
