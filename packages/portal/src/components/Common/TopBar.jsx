// src/components/Common/TopBar.jsx
import { LogOut, RefreshCw } from 'lucide-react'
import { useAuthStore } from '../../store/index.js'
import { useNavigate, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import api from '../../services/api.js'

const pageTitles = {
  '/': 'Dashboard',
  '/apis': 'API Catalogue',
  '/keys': 'API Keys',
  '/sla': 'SLA Monitor',
  '/costs': 'Cost Reports',
  '/alerts': 'Alerts',
}

export default function TopBar() {
  const { logout } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()

  const title = pageTitles[location.pathname] ||
    (location.pathname.startsWith('/apis/') ? 'API Detail' : 'NexGate')

  const handleLogout = async () => {
    logout()
    navigate('/login')
  }

  return (
    <header className="h-16 bg-gray-900 border-b border-gray-800 px-6 flex items-center justify-between flex-shrink-0">
      <h1 className="text-base font-semibold text-white">{title}</h1>
      <div className="flex items-center gap-2">
        <button
          onClick={() => queryClient.invalidateQueries()}
          className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          title="Refresh all data"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
        <button
          onClick={handleLogout}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm
                     text-gray-400 hover:text-red-400 hover:bg-red-900/20 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          <span>Logout</span>
        </button>
      </div>
    </header>
  )
}
