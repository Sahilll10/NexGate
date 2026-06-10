// src/components/Common/Sidebar.jsx
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, Globe, Key, ShieldCheck,
  DollarSign, Bell, ChevronLeft, ChevronRight, Zap
} from 'lucide-react'
import { useUIStore, useAuthStore } from '../../store/index.js'
import { useQuery } from '@tanstack/react-query'
import api from '../../services/api.js'

const navItems = [
  { to: '/',       icon: LayoutDashboard, label: 'Dashboard',   exact: true },
  { to: '/apis',   icon: Globe,           label: 'API Catalogue' },
  { to: '/keys',   icon: Key,             label: 'API Keys' },
  { to: '/sla',    icon: ShieldCheck,     label: 'SLA Monitor' },
  { to: '/costs',  icon: DollarSign,      label: 'Cost Reports' },
  { to: '/alerts', icon: Bell,            label: 'Alerts' },
]

export default function Sidebar() {
  const { sidebarOpen, toggleSidebar } = useUIStore()
  const user = useAuthStore(s => s.user)

  // Alert badge count
  const { data: alertsData } = useQuery({
    queryKey: ['alerts-count'],
    queryFn: () => api.get('/alerts?status=open&limit=1').then(r => r.data),
    refetchInterval: 30_000,
  })
  const openAlerts = alertsData?.total || 0

  return (
    <aside className={`fixed left-0 top-0 h-full bg-gray-900 border-r border-gray-800
                       flex flex-col transition-all duration-200 z-30
                       ${sidebarOpen ? 'w-60' : 'w-16'}`}>
      {/* Logo */}
      <div className={`flex items-center h-16 px-4 border-b border-gray-800 ${sidebarOpen ? 'gap-3' : 'justify-center'}`}>
        <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center flex-shrink-0">
          <Zap className="w-4 h-4 text-white" />
        </div>
        {sidebarOpen && (
          <div>
            <div className="text-sm font-bold text-white tracking-tight">NexGate</div>
            <div className="text-xs text-gray-500">API Gateway</div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
        {navItems.map(({ to, icon: Icon, label, exact }) => (
          <NavLink
            key={to}
            to={to}
            end={exact}
            className={({ isActive }) => isActive ? 'nav-item-active' : 'nav-item'}
          >
            <div className="relative flex-shrink-0">
              <Icon className="w-4 h-4" />
              {label === 'Alerts' && openAlerts > 0 && (
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full text-[8px] flex items-center justify-center text-white font-bold">
                  {openAlerts > 9 ? '9+' : openAlerts}
                </span>
              )}
            </div>
            {sidebarOpen && <span className="truncate">{label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* User + collapse */}
      <div className="p-3 border-t border-gray-800 space-y-2">
        {sidebarOpen && user && (
          <div className="flex items-center gap-2 px-2">
            <div className="w-7 h-7 rounded-full bg-brand-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
              {user.email?.[0]?.toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="text-xs text-white font-medium truncate">{user.email}</div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wide">{user.role}</div>
            </div>
          </div>
        )}
        <button
          onClick={toggleSidebar}
          className="flex items-center justify-center w-full h-8 rounded-lg
                     text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
        >
          {sidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
      </div>
    </aside>
  )
}
