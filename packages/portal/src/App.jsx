// src/App.jsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import { useAuthStore } from './store/index.js'
import { useSocket } from './hooks/useSocket.js'
import api from './services/api.js'

import Layout from './components/Common/Layout.jsx'
import LoginPage from './components/Common/LoginPage.jsx'
import Dashboard from './components/Dashboard/Dashboard.jsx'
import APICatalogue from './components/APIs/APICatalogue.jsx'
import APIDetail from './components/APIs/APIDetail.jsx'
import KeysManager from './components/Keys/KeysManager.jsx'
import SLADashboard from './components/SLA/SLADashboard.jsx'
import CostDashboard from './components/Costs/CostDashboard.jsx'
import AlertsPage from './components/Alerts/AlertsPage.jsx'

function SocketInitializer() {
  useSocket()
  return null
}

function PrivateRoute({ children }) {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  return isAuthenticated ? children : <Navigate to="/login" replace />
}

function App() {
  const { isAuthenticated, setUser, logout } = useAuthStore()

  useEffect(() => {
    if (isAuthenticated) {
      api.get('/auth/me')
        .then(res => setUser(res.data.user))
        .catch(() => logout())
    }
  }, [isAuthenticated])

  return (
    <BrowserRouter>
      {isAuthenticated && <SocketInitializer />}
      <Routes>
        <Route path="/login" element={
          isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />
        } />
        <Route path="/" element={
          <PrivateRoute><Layout /></PrivateRoute>
        }>
          <Route index element={<Dashboard />} />
          <Route path="apis" element={<APICatalogue />} />
          <Route path="apis/:apiId" element={<APIDetail />} />
          <Route path="keys" element={<KeysManager />} />
          <Route path="sla" element={<SLADashboard />} />
          <Route path="costs" element={<CostDashboard />} />
          <Route path="alerts" element={<AlertsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
