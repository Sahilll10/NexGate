// src/components/Dashboard/Dashboard.jsx
import { useQuery } from '@tanstack/react-query'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, BarChart, Bar
} from 'recharts'
import { Activity, Zap, AlertTriangle, TrendingUp, Clock, Shield } from 'lucide-react'
import { format } from 'date-fns'
import { useMetricsStore } from '../../store/index.js'
import api from '../../services/api.js'

// ─── STAT CARD ────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, icon: Icon, color = 'text-white', pulse }) {
  return (
    <div className="stat-card">
      <div className="flex items-center justify-between mb-2">
        <span className="stat-label">{label}</span>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${color.replace('text', 'bg')}/10`}>
          <Icon className={`w-4 h-4 ${color}`} />
        </div>
      </div>
      <div className="flex items-end gap-2">
        <span className={`stat-value ${color} ${pulse ? 'animate-pulse' : ''}`}>{value}</span>
        {sub && <span className="text-xs text-gray-500 mb-0.5">{sub}</span>}
      </div>
    </div>
  )
}

// ─── LIVE RPS INDICATOR ──────────────────────────────────────────────────────
function LiveRpsCard() {
  const { platformMetrics, platformHistory } = useMetricsStore()
  const isLive = !!platformMetrics.timestamp

  return (
    <div className="stat-card">
      <div className="flex items-center justify-between mb-2">
        <span className="stat-label">Live RPS</span>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600'}`} />
          <span className="text-xs text-gray-500">{isLive ? 'LIVE' : 'NO DATA'}</span>
        </div>
      </div>
      <div className="text-2xl font-semibold text-white mb-2">
        {platformMetrics.totalRps ?? '—'}
        <span className="text-sm font-normal text-gray-500 ml-1">req/s</span>
      </div>
      <div className="h-12">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={platformHistory} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="rpsGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#4f5ef7" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#4f5ef7" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="totalRps" stroke="#4f5ef7"
                  fill="url(#rpsGrad)" strokeWidth={1.5} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── TIMESERIES CHART ────────────────────────────────────────────────────────
function TimeseriesChart({ data }) {
  const formatted = data.map(d => ({
    ...d,
    time: format(new Date(d.timestamp), 'HH:mm'),
  }))

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-white">Request Volume & P95 Latency (24h)</h2>
        <span className="text-xs text-gray-500">5-minute buckets</span>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={formatted} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
            <defs>
              <linearGradient id="reqGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#4f5ef7" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#4f5ef7" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="latGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="time" tick={{ fontSize: 10, fill: '#6b7280' }}
                   tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis yAxisId="left" tick={{ fontSize: 10, fill: '#6b7280' }}
                   tickLine={false} axisLine={false} />
            <YAxis yAxisId="right" orientation="right"
                   tick={{ fontSize: 10, fill: '#6b7280' }}
                   tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: 8 }}
              labelStyle={{ color: '#9ca3af', fontSize: 11 }}
              itemStyle={{ fontSize: 11 }}
            />
            <Area yAxisId="left" type="monotone" dataKey="requestCount"
                  stroke="#4f5ef7" fill="url(#reqGrad)" strokeWidth={1.5}
                  dot={false} name="Requests" />
            <Area yAxisId="right" type="monotone" dataKey="p95LatencyMs"
                  stroke="#f59e0b" fill="url(#latGrad)" strokeWidth={1.5}
                  dot={false} name="P95 Latency (ms)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── TOP APIS TABLE ──────────────────────────────────────────────────────────
function TopApisTable({ apis }) {
  if (!apis?.length) return (
    <div className="text-center py-8 text-gray-500 text-sm">No API data yet</div>
  )
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="table-header">API Name</th>
            <th className="table-header text-right">Requests (24h)</th>
          </tr>
        </thead>
        <tbody>
          {apis.map((a, i) => (
            <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
              <td className="table-cell">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded bg-gray-800 text-xs flex items-center justify-center text-gray-400 font-mono">
                    {i + 1}
                  </span>
                  <span className="text-white font-medium">{a.apiName || a._id}</span>
                </div>
              </td>
              <td className="table-cell text-right font-mono">
                {a.requestCount.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── MAIN DASHBOARD ──────────────────────────────────────────────────────────
export default function Dashboard() {
  const { data: overview, isLoading: overviewLoading } = useQuery({
    queryKey: ['analytics-overview'],
    queryFn: () => api.get('/analytics/overview').then(r => r.data),
    refetchInterval: 30_000,
  })

  const { data: timeseries } = useQuery({
    queryKey: ['analytics-timeseries'],
    queryFn: () => api.get('/analytics/timeseries?hours=24&interval=5m').then(r => r.data),
    refetchInterval: 60_000,
  })

  const { data: alertsData } = useQuery({
    queryKey: ['alerts-open'],
    queryFn: () => api.get('/alerts?status=open&limit=5').then(r => r.data),
    refetchInterval: 30_000,
  })

  const stats = overview?.last24h || {}

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Platform Overview</h2>
          <p className="text-sm text-gray-500 mt-0.5">Last 24 hours · Auto-refreshes every 30s</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs text-emerald-400 font-medium">Live</span>
        </div>
      </div>

      {/* Stat Cards Row */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <LiveRpsCard />
        <StatCard
          label="Total Requests (24h)"
          value={overviewLoading ? '—' : (stats.totalRequests || 0).toLocaleString()}
          icon={Activity}
          color="text-brand-400"
        />
        <StatCard
          label="Avg P95 Latency"
          value={overviewLoading ? '—' : `${stats.avgLatencyMs || 0}ms`}
          icon={Clock}
          color="text-yellow-400"
        />
        <StatCard
          label="Error Rate"
          value={overviewLoading ? '—' : `${stats.errorRatePct || 0}%`}
          sub="5xx responses"
          icon={AlertTriangle}
          color={parseFloat(stats.errorRatePct) > 1 ? 'text-red-400' : 'text-emerald-400'}
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2">
          {timeseries?.series && <TimeseriesChart data={timeseries.series} />}
        </div>

        {/* Open Alerts */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">Open Alerts</h2>
            <span className="badge-red">{alertsData?.total || 0} open</span>
          </div>
          <div className="space-y-2">
            {alertsData?.alerts?.length === 0 && (
              <div className="flex flex-col items-center py-6 text-center">
                <Shield className="w-8 h-8 text-emerald-500 mb-2" />
                <p className="text-sm text-gray-400">All systems healthy</p>
              </div>
            )}
            {alertsData?.alerts?.map(alert => (
              <div key={alert._id} className={`p-3 rounded-lg border text-xs space-y-1
                ${alert.severity === 'critical'
                  ? 'bg-red-900/20 border-red-800/50'
                  : 'bg-yellow-900/20 border-yellow-800/50'}`}>
                <div className="flex items-center gap-1.5">
                  <span className={alert.severity === 'critical' ? 'text-red-400' : 'text-yellow-400'}>
                    {alert.type.replace(/_/g, ' ')}
                  </span>
                </div>
                <p className="text-gray-400 line-clamp-2">{alert.message}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Top APIs */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">Top APIs by Request Volume (24h)</h2>
          <TrendingUp className="w-4 h-4 text-gray-500" />
        </div>
        <TopApisTable apis={overview?.topApis} />
      </div>
    </div>
  )
}
