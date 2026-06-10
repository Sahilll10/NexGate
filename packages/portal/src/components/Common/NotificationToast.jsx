// src/components/Common/NotificationToast.jsx
import { useEffect } from 'react'
import { X, AlertTriangle, CheckCircle, Info, AlertCircle } from 'lucide-react'
import { useUIStore } from '../../store/index.js'

const icons = {
  error:   <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />,
  warning: <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0" />,
  success: <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />,
  info:    <Info className="w-4 h-4 text-blue-400 flex-shrink-0" />,
}

const borders = {
  error: 'border-red-800/50',
  warning: 'border-yellow-800/50',
  success: 'border-emerald-800/50',
  info: 'border-blue-800/50',
}

function Toast({ notification }) {
  const dismiss = useUIStore(s => s.dismissNotification)
  useEffect(() => {
    const t = setTimeout(() => dismiss(notification.id), 5000)
    return () => clearTimeout(t)
  }, [notification.id])

  return (
    <div className={`flex items-start gap-3 bg-gray-900 border ${borders[notification.type] || 'border-gray-700'}
                     rounded-xl p-4 shadow-2xl w-80 animate-slide-in`}>
      {icons[notification.type] || icons.info}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white truncate">{notification.title}</p>
        {notification.message && (
          <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{notification.message}</p>
        )}
      </div>
      <button onClick={() => dismiss(notification.id)}
              className="text-gray-600 hover:text-gray-300 transition-colors flex-shrink-0">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

export default function NotificationToast() {
  const notifications = useUIStore(s => s.notifications)
  if (!notifications.length) return null
  return (
    <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50">
      {notifications.map(n => <Toast key={n.id} notification={n} />)}
    </div>
  )
}
