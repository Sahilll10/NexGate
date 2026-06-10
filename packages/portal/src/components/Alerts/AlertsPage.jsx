// src/components/Alerts/AlertsPage.jsx
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Bell, Check, CheckCheck, Filter, AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { format, formatDistanceToNow } from 'date-fns'
import api from '../../services/api.js'
import { useUIStore } from '../../store/index.js'

const severityConfig = {
  critical: { cls: 'border-l-red-500 bg-red-900/10',    badge: 'badge-red',    icon: AlertCircle,   iconCls: 'text-red-400' },
  warning:  { cls: 'border-l-yellow-500 bg-yellow-900/10', badge: 'badge-yellow', icon: AlertTriangle, iconCls: 'text-yellow-400' },
  info:     { cls: 'border-l-blue-500 bg-blue-900/10',   badge: 'badge-blue',   icon: Info,          iconCls: 'text-blue-400' },
}

const typeLabels = {
  RATE_LIMIT_BREACH: 'Rate Limit Breach',
  SLA_PRE_BREACH:    'SLA Pre-Breach',
  SLA_BREACH:        'SLA Breach',
  BUDGET_PRE_BREACH: 'Budget Warning',
  BUDGET_BREACH:     'Budget Exceeded',
  CIRCUIT_OPEN:      'Circuit Open',
}

function AlertRow({ alert, onAck, onResolve }) {
  const { cls, badge, icon: Icon, iconCls } = severityConfig[alert.severity] || severityConfig.info
  const isOpen = alert.status === 'open'
  const isAcked = alert.status === 'acknowledged'

  return (
    <div className={`card border-l-4 ${cls} hover:brightness-110 transition-all`}>
      <div className="flex items-start gap-3">
        <Icon className={`w-4 h-4 flex-shrink-0 mt-0.5 ${iconCls}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-white">
                {typeLabels[alert.type] || alert.type}
              </span>
              <span className={badge}>{alert.severity}</span>
              <span className={`badge ${
                alert.status === 'open' ? 'badge-red'
                : alert.status === 'acknowledged' ? 'badge-yellow' : 'badge-gray'
              }`}>
                {alert.status}
              </span>
            </div>
            <span className="text-xs text-gray-600 flex-shrink-0">
              {formatDistanceToNow(new Date(alert.createdAt), { addSuffix: true })}
            </span>
          </div>

          <p className="text-sm text-gray-300 mt-1">{alert.message}</p>

          <div className="flex items-center gap-4 mt-2 flex-wrap">
            {alert.teamId && (
              <span className="text-xs text-gray-500">
                Team: <span className="text-gray-400">{alert.teamId?.name || alert.teamId}</span>
              </span>
            )}
            {alert.apiId && (
              <span className="text-xs text-gray-500">
                API: <span className="text-gray-400">{alert.apiId?.name || alert.apiId}</span>
              </span>
            )}
            <span className="text-xs text-gray-600">
              {format(new Date(alert.createdAt), 'MMM d, yyyy HH:mm:ss')}
            </span>
          </div>

          {alert.details && Object.keys(alert.details).length > 0 && (
            <div className="mt-2 text-xs text-gray-500 font-mono bg-gray-800/50 rounded-lg p-2 overflow-x-auto">
              {Object.entries(alert.details)
                .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
                .map(([k, v]) => (
                  <span key={k} className="mr-3">
                    <span className="text-gray-600">{k}:</span>{' '}
                    <span className="text-gray-300">{String(v)}</span>
                  </span>
                ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1 flex-shrink-0">
          {isOpen && (
            <button
              onClick={() => onAck(alert._id)}
              className="p-1.5 rounded-lg text-gray-500 hover:text-yellow-400
                         hover:bg-yellow-900/20 transition-colors"
              title="Acknowledge"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
          )}
          {(isOpen || isAcked) && (
            <button
              onClick={() => onResolve(alert._id)}
              className="p-1.5 rounded-lg text-gray-500 hover:text-emerald-400
                         hover:bg-emerald-900/20 transition-colors"
              title="Resolve"
            >
              <CheckCheck className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function AlertsPage() {
  const queryClient = useQueryClient()
  const addNotification = useUIStore(s => s.addNotification)
  const [statusFilter, setStatusFilter] = useState('open')
  const [typeFilter, setTypeFilter] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['alerts', statusFilter, typeFilter],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' })
      if (statusFilter) params.set('status', statusFilter)
      if (typeFilter) params.set('type', typeFilter)
      return api.get(`/alerts?${params}`).then(r => r.data)
    },
    refetchInterval: 15_000,
  })

  const ackMutation = useMutation({
    mutationFn: (id) => api.post(`/alerts/${id}/acknowledge`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alerts'] })
      queryClient.invalidateQueries({ queryKey: ['alerts-count'] })
      addNotification({ type: 'info', title: 'Alert Acknowledged' })
    },
  })

  const resolveMutation = useMutation({
    mutationFn: (id) => api.post(`/alerts/${id}/resolve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alerts'] })
      queryClient.invalidateQueries({ queryKey: ['alerts-count'] })
      addNotification({ type: 'success', title: 'Alert Resolved' })
    },
  })

  const alerts = data?.alerts || []
  const totalOpen = data?.total || 0

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Alerts</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {totalOpen} {statusFilter || 'total'} alerts
          </p>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
          <span className="text-xs text-gray-500">Auto-refreshes every 15s</span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Filter className="w-3.5 h-3.5 text-gray-500" />
          <span className="text-xs text-gray-500">Filter:</span>
        </div>
        <div className="flex gap-2">
          {['open', 'acknowledged', 'resolved', ''].map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === s
                  ? 'bg-brand-600/30 text-brand-300 border border-brand-600/50'
                  : 'bg-gray-800 text-gray-400 border border-gray-700 hover:text-white'
              }`}
            >
              {s === '' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <select
          className="input max-w-xs py-1.5 text-xs"
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
        >
          <option value="">All Types</option>
          {Object.entries(typeLabels).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {/* Alert List */}
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="card h-20 animate-pulse bg-gray-800" />
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <div className="card text-center py-16">
          <Bell className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">No {statusFilter || ''} alerts</p>
          <p className="text-gray-600 text-sm mt-1">
            {statusFilter === 'open' ? 'All systems are healthy 🎉' : 'Nothing to show'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map(alert => (
            <AlertRow
              key={alert._id}
              alert={alert}
              onAck={(id) => ackMutation.mutate(id)}
              onResolve={(id) => resolveMutation.mutate(id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
