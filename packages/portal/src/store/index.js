// src/store/index.js
import { create } from 'zustand'

// ─── AUTH STORE ───────────────────────────────────────────────────────────────
export const useAuthStore = create((set) => ({
  user: null,
  token: localStorage.getItem('nexgate_token'),
  isAuthenticated: !!localStorage.getItem('nexgate_token'),

  login: (user, token, refreshToken) => {
    localStorage.setItem('nexgate_token', token)
    localStorage.setItem('nexgate_refresh', refreshToken)
    set({ user, token, isAuthenticated: true })
  },

  logout: () => {
    localStorage.removeItem('nexgate_token')
    localStorage.removeItem('nexgate_refresh')
    set({ user: null, token: null, isAuthenticated: false })
  },

  setUser: (user) => set({ user }),
}))

// ─── LIVE METRICS STORE ───────────────────────────────────────────────────────
// Updated by Socket.io events — drives real-time dashboard components
// State shape: { [apiId]: { rps, p95LatencyMs, avgLatencyMs, errorRatePct, timestamp } }
export const useMetricsStore = create((set, get) => ({
  // Per-API live metrics (last received)
  apiMetrics: {},

  // Platform-wide aggregate (admin only)
  platformMetrics: {
    totalRps: 0,
    maxP95LatencyMs: 0,
    activeApis: 0,
    timestamp: null,
  },

  // Rolling history for sparklines (last 60 data points = 60 seconds at 1/sec emit)
  history: {},      // { [apiId]: [{ timestamp, rps, p95LatencyMs }] }
  platformHistory: [],

  MAX_HISTORY: 60,

  updateApiMetrics: (metric) => {
    const { apiMetrics, history, MAX_HISTORY } = get()
    const apiHistory = history[metric.apiId] || []
    const newHistory = [...apiHistory, {
      timestamp: metric.timestamp,
      rps: metric.rps,
      p95LatencyMs: metric.p95LatencyMs,
      errorRatePct: parseFloat(metric.errorRatePct),
    }].slice(-MAX_HISTORY)

    set({
      apiMetrics: { ...apiMetrics, [metric.apiId]: metric },
      history: { ...history, [metric.apiId]: newHistory },
    })
  },

  updatePlatformMetrics: (metric) => {
    const { platformHistory, MAX_HISTORY } = get()
    const newHistory = [...platformHistory, {
      timestamp: metric.timestamp,
      totalRps: metric.totalRps,
      maxP95LatencyMs: metric.maxP95LatencyMs,
    }].slice(-MAX_HISTORY)

    set({ platformMetrics: metric, platformHistory: newHistory })
  },

  clearMetrics: () => set({ apiMetrics: {}, history: {}, platformHistory: [] }),
}))

// ─── UI STORE ─────────────────────────────────────────────────────────────────
export const useUIStore = create((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set(s => ({ sidebarOpen: !s.sidebarOpen })),

  notifications: [],
  addNotification: (n) => set(s => ({
    notifications: [{ id: Date.now(), ...n }, ...s.notifications].slice(0, 10)
  })),
  dismissNotification: (id) => set(s => ({
    notifications: s.notifications.filter(n => n.id !== id)
  })),
}))
