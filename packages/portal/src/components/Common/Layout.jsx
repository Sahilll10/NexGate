// src/components/Common/Layout.jsx
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar.jsx'
import TopBar from './TopBar.jsx'
import NotificationToast from './NotificationToast.jsx'
import { useUIStore } from '../../store/index.js'

export default function Layout() {
  const sidebarOpen = useUIStore(s => s.sidebarOpen)
  return (
    <div className="flex h-screen overflow-hidden bg-gray-950">
      <Sidebar />
      <div className={`flex-1 flex flex-col min-w-0 transition-all duration-200 ${sidebarOpen ? 'ml-60' : 'ml-16'}`}>
        <TopBar />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
      <NotificationToast />
    </div>
  )
}
