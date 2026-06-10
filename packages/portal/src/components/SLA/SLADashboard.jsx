// src/components/SLA/SLADashboard.jsx
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, ShieldAlert, ShieldX, Plus, X, Loader2 } from 'lucide-react'
import api from '../../services/api.js'
import { useUIStore } from '../../store/index.js'
import { format } from 'date-fns'

const statusConfig = {
  ok:         { label: 'Healthy',     cls: 'badge-green',  icon: ShieldCheck },
  pre_breach: { label: 'Warning',     cls: 'badge-yellow', icon: ShieldAlert },
  breach:     { label: 'Breached',    cls: 'badge-red',    icon: ShieldX },
  unknown:    { label: 'No Data',     cls: 'badge-gray',   icon: ShieldCheck },
}

function SlaCard({ sla }) {
  const { label, cls, icon: Icon } = statusConfig[sla.currentStatus] || statusConfig.unknown
  const latencyPct = sla.maxP95LatencyMs > 0
    ? Math.min(100, (sla.lastP95LatencyMs / sla.maxP95LatencyMs) * 100)
    : 0
  const barColor = sla.currentStatus === 'breach' ? 'bg-red-500'
                 : sla.currentStatus === 'pre_breach' ? 'bg-yellow-500' : 'bg-emerald-500'

  return (
    <div className={`card border-l-4 ${
      sla.currentStatus === 'breach' ? 'border-l-red-500'
      : sla.currentStatus === 'pre_breach' ? 'border-l-yellow-500'
      : 'border-l-emerald-500'
    }`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-semibold text-white">{sla.name}</span>
            <span className={cls}>{label}</span>
          </div>
          <div className="text-xs text-gray-500">{sla.apiId?.name || 'All APIs'}</div>
        </div>
        <Icon className={`w-5 h-5 flex-shrink-0 ${
          sla.currentStatus === 'breach' ? 'text-red-400'
          : sla.currentStatus === 'pre_breach' ? 'text-yellow-400' : 'text-emerald-400'
        }`} />
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <div className="text-xs text-gray-500 mb-1">P95 Latency</div>
          <div className="text-lg font-semibold text-white">
            {sla.lastP95LatencyMs || '—'}
            <span className="text-xs text-gray-500 font-normal ml-1">
              / {sla.maxP95LatencyMs}ms
            </span>
          </div>
          <div className="h-1.5 bg-gray-800 rounded-full mt-1 overflow-hidden">
            <div className={`h-full rounded-full transition-all ${barColor}`}
                 style={{ width: `${latencyPct}%` }} />
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 mb-1">Error Rate</div>
          <div className="text-lg font-semibold text-white">
            {sla.lastErrorRatePct?.toFixed(2) || '—'}
            <span className="text-xs text-gray-500 font-normal ml-1">
              / {sla.maxErrorRatePct}%
            </span>
          </div>
        </div>
      </div>

      <div className="text-xs text-gray-600">
        Alert at {sla.alertThresholdPct}% · Last checked{' '}
        {sla.lastEvaluatedAt
          ? format(new Date(sla.lastEvaluatedAt), 'HH:mm:ss')
          : 'never'}
      </div>
    </div>
  )
}

function NewSlaModal({ onClose }) {
  const queryClient = useQueryClient()
  const addNotification = useUIStore(s => s.addNotification)
  const [form, setForm] = useState({
    name: '', apiId: '', maxP95LatencyMs: 500, maxErrorRatePct: 1, alertThresholdPct: 90,
  })
  const { data: apisData } = useQuery({
    queryKey: ['apis', ''],
    queryFn: () => api.get('/apis?limit=100').then(r => r.data),
  })
  const mutation = useMutation({
    mutationFn: (d) => api.post('/sla', d),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sla'] })
      addNotification({ type: 'success', title: 'SLA Created' })
      onClose()
    },
  })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h3 className="font-semibold text-white">New SLA Definition</h3>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-500 hover:text-white" /></button>
        </div>
        <form onSubmit={e => { e.preventDefault(); mutation.mutate(form) }} className="p-5 space-y-4">
          <div>
            <label className="label">SLA Name *</label>
            <input className="input" required value={form.name} onChange={e => set('name', e.target.value)}
                   placeholder="Payment API — Gold SLA" />
          </div>
          <div>
            <label className="label">API *</label>
            <select className="input" required value={form.apiId} onChange={e => set('apiId', e.target.value)}>
              <option value="">Select API...</option>
              {apisData?.apis?.map(a => <option key={a._id} value={a._id}>{a.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">Max P95 (ms)</label>
              <input type="number" className="input" value={form.maxP95LatencyMs}
                     onChange={e => set('maxP95LatencyMs', Number(e.target.value))} />
            </div>
            <div>
              <label className="label">Max Error %</label>
              <input type="number" step="0.1" className="input" value={form.maxErrorRatePct}
                     onChange={e => set('maxErrorRatePct', Number(e.target.value))} />
            </div>
            <div>
              <label className="label">Alert at %</label>
              <input type="number" className="input" value={form.alertThresholdPct}
                     onChange={e => set('alertThresholdPct', Number(e.target.value))} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={mutation.isPending} className="btn-primary flex items-center gap-2">
              {mutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Create SLA
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function SLADashboard() {
  const [showModal, setShowModal] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['sla'],
    queryFn: () => api.get('/sla').then(r => r.data),
    refetchInterval: 30_000,
  })
  const slas = data?.slas || []
  const breached = slas.filter(s => s.currentStatus === 'breach').length
  const warning  = slas.filter(s => s.currentStatus === 'pre_breach').length
  const healthy  = slas.filter(s => s.currentStatus === 'ok').length

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">SLA Monitor</h2>
          <p className="text-sm text-gray-500 mt-0.5">Evaluated every 5 minutes · Sliding window</p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          New SLA
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="stat-card"><span className="stat-label">Healthy</span><span className="stat-value text-emerald-400">{healthy}</span></div>
        <div className="stat-card"><span className="stat-label">Warning</span><span className="stat-value text-yellow-400">{warning}</span></div>
        <div className="stat-card"><span className="stat-label">Breached</span><span className="stat-value text-red-400">{breached}</span></div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => <div key={i} className="card h-40 animate-pulse bg-gray-800" />)}
        </div>
      ) : slas.length === 0 ? (
        <div className="card text-center py-16">
          <ShieldCheck className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">No SLA definitions yet</p>
          <p className="text-gray-600 text-sm mt-1">Create SLA targets to monitor API performance</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {slas.map(sla => <SlaCard key={sla._id} sla={sla} />)}
        </div>
      )}

      {showModal && <NewSlaModal onClose={() => setShowModal(false)} />}
    </div>
  )
}
