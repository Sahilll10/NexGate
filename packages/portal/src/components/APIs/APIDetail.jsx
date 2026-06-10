// src/components/APIs/APIDetail.jsx
import { useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { ArrowLeft, Activity, Clock, AlertTriangle, Zap } from 'lucide-react'
import { format } from 'date-fns'
import api from '../../services/api.js'
import { useSocket } from '../../hooks/useSocket.js'
import { useMetricsStore } from '../../store/index.js'

function Sparkline({ data, dataKey, color }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <defs>
          <linearGradient id={`grad-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey={dataKey} stroke={color}
              fill={`url(#grad-${dataKey})`} strokeWidth={1.5} dot={false} />
        <Tooltip
          contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: 6, fontSize: 10 }}
          formatter={(v) => [v, dataKey]}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export default function APIDetail() {
  const { apiId } = useParams()
  const { subscribeToApi, unsubscribeFromApi } = useSocket()
  const liveMetric = useMetricsStore(s => s.apiMetrics[apiId])
  const history = useMetricsStore(s => s.history[apiId] || [])

  useEffect(() => {
    subscribeToApi(apiId)
    return () => unsubscribeFromApi(apiId)
  }, [apiId])

  const { data: apiData, isLoading } = useQuery({
    queryKey: ['api', apiId],
    queryFn: () => api.get(`/apis/${apiId}`).then(r => r.data),
  })

  const { data: tsData } = useQuery({
    queryKey: ['api-timeseries', apiId],
    queryFn: () => api.get(`/analytics/timeseries?apiId=${apiId}&hours=6&interval=5m`).then(r => r.data),
    refetchInterval: 60_000,
  })

  const { data: slaData } = useQuery({
    queryKey: ['sla', apiId],
    queryFn: () => api.get(`/sla?apiId=${apiId}`).then(r => r.data),
  })

  if (isLoading) return (
    <div className="space-y-4">
      <div className="h-8 bg-gray-800 rounded w-64 animate-pulse" />
      <div className="grid grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="card h-28 animate-pulse bg-gray-800" />
        ))}
      </div>
    </div>
  )

  const apiDoc = apiData?.api
  const sla = slaData?.slas?.[0]

  const statusColors = {
    ok: 'badge-green', pre_breach: 'badge-yellow',
    breach: 'badge-red', unknown: 'badge-gray',
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to="/apis" className="text-gray-500 hover:text-white transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold text-white">{apiDoc?.name}</h2>
            <span className="text-gray-500 text-sm">{apiDoc?.version}</span>
            {apiDoc?.isActive ? <span className="badge-green">Active</span> : <span className="badge-gray">Inactive</span>}
          </div>
          <p className="text-sm text-gray-500 mt-0.5 truncate">
            → {apiDoc?.targetBaseUrl}
          </p>
        </div>
        {sla && (
          <span className={statusColors[sla.currentStatus] || 'badge-gray'}>
            SLA: {sla.currentStatus?.toUpperCase()}
          </span>
        )}
      </div>

      {/* Live Stat Cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {[
          { label: 'Live RPS', value: liveMetric?.rps ?? '—', icon: Activity, color: 'text-brand-400', histKey: 'rps' },
          { label: 'P95 Latency', value: liveMetric ? `${liveMetric.p95LatencyMs}ms` : '—', icon: Clock, color: 'text-yellow-400', histKey: 'p95LatencyMs' },
          { label: 'Error Rate', value: liveMetric ? `${liveMetric.errorRatePct}%` : '—', icon: AlertTriangle, color: parseFloat(liveMetric?.errorRatePct) > 1 ? 'text-red-400' : 'text-emerald-400', histKey: 'errorRatePct' },
          { label: 'Timeout', value: `${apiDoc?.timeoutMs || 30000}ms`, icon: Zap, color: 'text-gray-400' },
        ].map(({ label, value, icon: Icon, color, histKey }) => (
          <div key={label} className="stat-card">
            <div className="flex items-center justify-between mb-1">
              <span className="stat-label">{label}</span>
              <Icon className={`w-4 h-4 ${color}`} />
            </div>
            <div className={`stat-value ${color}`}>{value}</div>
            {histKey && history.length > 1 && (
              <div className="h-10 mt-2">
                <Sparkline
                  data={history}
                  dataKey={histKey}
                  color={color.replace('text-', '#').includes('brand') ? '#4f5ef7'
                       : color.includes('yellow') ? '#f59e0b'
                       : color.includes('red') ? '#ef4444'
                       : color.includes('emerald') ? '#10b981' : '#6b7280'}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 6-Hour Chart */}
      {tsData?.series && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-white">Request Volume (Last 6 Hours)</h3>
            <span className="text-xs text-gray-500">5-min buckets</span>
          </div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={tsData.series.map(d => ({ ...d, time: format(new Date(d.timestamp), 'HH:mm') }))}
                         margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <defs>
                  <linearGradient id="apiGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#4f5ef7" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#4f5ef7" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" tick={{ fontSize: 10, fill: '#6b7280' }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: 8 }}
                         labelStyle={{ color: '#9ca3af', fontSize: 11 }} itemStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="requestCount" stroke="#4f5ef7"
                      fill="url(#apiGrad)" strokeWidth={1.5} dot={false} name="Requests" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* API Config */}
      <div className="card">
        <h3 className="text-sm font-semibold text-white mb-4">Configuration</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          {[
            ['Owner Team', apiDoc?.ownerTeamId?.name || apiDoc?.ownerTeamId],
            ['Target URL', apiDoc?.targetBaseUrl],
            ['Version', apiDoc?.version],
            ['Timeout', `${apiDoc?.timeoutMs}ms`],
            ['Strip API Key Header', apiDoc?.stripApiKeyHeader ? 'Yes' : 'No'],
            ['Public Catalogue', apiDoc?.isPublic ? 'Yes' : 'No'],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5">
              <span className="text-xs text-gray-500">{k}</span>
              <span className="text-gray-200 font-mono text-xs truncate">{v || '—'}</span>
            </div>
          ))}
        </div>
        {apiDoc?.tags?.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {apiDoc.tags.map(t => (
              <span key={t} className="text-xs px-2 py-0.5 bg-gray-800 text-gray-400 rounded border border-gray-700">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
