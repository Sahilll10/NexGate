// src/components/Costs/CostDashboard.jsx
import { useQuery } from '@tanstack/react-query'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { DollarSign, TrendingUp, Activity } from 'lucide-react'
import api from '../../services/api.js'

function BudgetBar({ used, total }) {
  if (!total) return <span className="text-xs text-gray-600">No budget set</span>
  const pct = Math.min(100, (used / total) * 100)
  const color = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-500' : 'bg-emerald-500'
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-gray-400">
        <span>${(used / 100).toFixed(2)}</span>
        <span className="text-gray-600">of ${(total / 100).toFixed(2)} ({pct.toFixed(0)}%)</span>
      </div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function CostDashboard() {
  const { data: summary, isLoading } = useQuery({
    queryKey: ['cost-summary'],
    queryFn: () => api.get('/costs/summary').then(r => r.data),
    refetchInterval: 60_000,
  })
  const { data: reports } = useQuery({
    queryKey: ['cost-reports'],
    queryFn: () => api.get('/costs').then(r => r.data),
  })

  const chartData = summary?.teamBreakdown?.map(t => ({
    name: t.team?.name || 'Unknown',
    cost: parseFloat((t.costCents / 100).toFixed(2)),
    requests: t.requests,
  })) || []

  const colors = ['#4f5ef7', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4']

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-white">Cost Reports</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Month-to-date · {summary?.month || '—'} · Aggregated nightly
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="stat-card">
          <span className="stat-label">Total MTD Cost</span>
          <span className="stat-value text-brand-400">
            ${isLoading ? '—' : (summary?.totalCostUsd || '0.00')}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Total Requests MTD</span>
          <span className="stat-value">
            {isLoading ? '—' : (summary?.totalRequests || 0).toLocaleString()}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Active Teams</span>
          <span className="stat-value">{summary?.teamBreakdown?.length || 0}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Bar Chart */}
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-4">Cost by Team (USD)</h3>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#6b7280' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} tickLine={false} axisLine={false}
                       tickFormatter={v => `$${v}`} />
                <Tooltip contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: 8 }}
                         formatter={(v) => [`$${v}`, 'Cost']} />
                <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
                  {chartData.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Team Budget Table */}
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-4">Budget Utilization</h3>
          <div className="space-y-4">
            {summary?.teamBreakdown?.length === 0 && (
              <p className="text-gray-500 text-sm text-center py-8">No cost data yet</p>
            )}
            {summary?.teamBreakdown?.map((t, i) => (
              <div key={i}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm text-white font-medium">{t.team?.name}</span>
                  <span className="text-xs text-gray-500">{t.requests.toLocaleString()} requests</span>
                </div>
                <BudgetBar used={t.costCents} total={reports?.reports?.find(
                  r => r.teamId?._id === t.team?._id
                )?.budgetCents || 0} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Historical Reports Table */}
      <div className="card p-0 overflow-hidden">
        <div className="p-5 border-b border-gray-800">
          <h3 className="text-sm font-semibold text-white">Historical Reports</h3>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="table-header">Team</th>
              <th className="table-header">Month</th>
              <th className="table-header">Requests</th>
              <th className="table-header">Cost</th>
              <th className="table-header">Budget Used</th>
            </tr>
          </thead>
          <tbody>
            {reports?.reports?.map(r => (
              <tr key={r._id} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                <td className="table-cell text-white">{r.teamId?.name}</td>
                <td className="table-cell font-mono">{r.month}</td>
                <td className="table-cell">{r.totalRequestsMtd?.toLocaleString()}</td>
                <td className="table-cell text-brand-400">${(r.totalCentsMtd / 100).toFixed(2)}</td>
                <td className="table-cell">
                  <span className={`font-medium ${
                    r.budgetUtilizationPct >= 100 ? 'text-red-400'
                    : r.budgetUtilizationPct >= 80 ? 'text-yellow-400' : 'text-emerald-400'
                  }`}>
                    {r.budgetUtilizationPct?.toFixed(1)}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
