// src/hooks/useSocket.js
import { useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import { useAuthStore, useMetricsStore, useUIStore } from '../store/index.js'

let socketInstance = null

export function useSocket() {
  const token = useAuthStore(s => s.token)
  const { updateApiMetrics, updatePlatformMetrics } = useMetricsStore()
  const addNotification = useUIStore(s => s.addNotification)
  const connectedRef = useRef(false)

  useEffect(() => {
    if (!token || connectedRef.current) return

    const SOCKET_URL = import.meta.env.VITE_API_URL?.replace('/api', '') || ''

    socketInstance = io(`${SOCKET_URL}/metrics`, {
      auth: { token },
      transports: ['websocket'],
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    })

    socketInstance.on('connect', () => {
      connectedRef.current = true
      console.info('[Socket.io] Connected to /metrics namespace')
    })

    socketInstance.on('disconnect', (reason) => {
      connectedRef.current = false
      console.warn('[Socket.io] Disconnected:', reason)
    })

    socketInstance.on('connect_error', (err) => {
      console.error('[Socket.io] Connection error:', err.message)
    })

    // Per-API metrics event — updates the metrics store
    socketInstance.on('metrics:api', (metric) => {
      updateApiMetrics(metric)
    })

    // Team-level aggregate metrics
    socketInstance.on('metrics:team', (metric) => {
      updateApiMetrics(metric)
    })

    // Platform-wide metrics (admin)
    socketInstance.on('metrics:platform', (metric) => {
      updatePlatformMetrics(metric)
    })

    // Alert notifications from backend
    socketInstance.on('alert:new', (alert) => {
      addNotification({
        type: alert.severity === 'critical' ? 'error' : 'warning',
        title: alert.type.replace(/_/g, ' '),
        message: alert.message,
      })
    })

    return () => {
      if (socketInstance) {
        socketInstance.disconnect()
        socketInstance = null
        connectedRef.current = false
      }
    }
  }, [token])

  const subscribeToApi = (apiId) => {
    socketInstance?.emit('subscribe:api', apiId)
  }

  const unsubscribeFromApi = (apiId) => {
    socketInstance?.emit('unsubscribe:api', apiId)
  }

  return { subscribeToApi, unsubscribeFromApi, socket: socketInstance }
}
