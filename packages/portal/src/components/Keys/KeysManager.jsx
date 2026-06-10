// src/components/Keys/KeysManager.jsx
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Key, Plus, RotateCcw, Trash2, Copy, Eye, EyeOff, X, Loader2, Shield } from 'lucide-react'
import { format } from 'date-fns'
import api from '../../services/api.js'
import { useUIStore } from '../../store/index.js'

// ─── NEW KEY REVEALED MODAL ──────────────────────────────────────────────────
function KeyRevealModal({ rawKey, onClose }) {
  const [copied, setCopied] = useState(false)
  const [visible, setVisible] = useState(false)

  const copyKey = () => {
    navigator.clipboard.writeText(rawKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-yellow-700/50 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="p-5 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-yellow-900/40 flex items-center justify-center">
              <Shield className="w-5 h-5 text-yellow-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white">Save Your API Key</h3>
              <p className="text-xs text-yellow-400 mt-0.5">This key will NEVER be shown again</p>
            </div>
          </div>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-500 font-medium">API Key</span>
              <button onClick={() => setVisible(!visible)}
                      className="text-gray-500 hover:text-gray-300 transition-colors">
                {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            <code className="block text-sm font-mono text-emerald-400 break-all">
              {visible ? rawKey : rawKey.slice(0, 8) + '•'.repeat(rawKey.length - 12) + rawKey.slice(-4)}
            </code>
          </div>
          <button onClick={copyKey}
                  className="btn-primary w-full flex items-center justify-center gap-2">
            <Copy className="w-4 h-4" />
            {copied ? '✓ Copied!' : 'Copy to Clipboard'}
          </button>
          <p className="text-xs text-gray-500 text-center">
            Store this key in your secrets manager (HashiCorp Vault, AWS Secrets Manager, etc.)
            before closing this window.
          </p>
          <button onClick={onClose}
                  className="btn-secondary w-full">
            I've saved the key — Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── GENERATE KEY MODAL ──────────────────────────────────────────────────────
function GenerateKeyModal({ onClose, onSuccess }) {
  const { data: teamsData } = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get('/teams').then(r => r.data),
  })
  const { data: apisData } = useQuery({
    queryKey: ['apis', ''],
    queryFn: () => api.get('/apis?limit=100').then(r => r.data),
  })

  const [form, setForm] = useState({
    name: '', teamId: '', allowedApiIds: [], scopes: ['read'], expiresAt: '',
  })

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const toggleApi = (id) => {
    set('allowedApiIds', form.allowedApiIds.includes(id)
      ? form.allowedApiIds.filter(a => a !== id)
      : [...form.allowedApiIds, id])
  }

  const toggleScope = (scope) => {
    set('scopes', form.scopes.includes(scope)
      ? form.scopes.filter(s => s !== scope)
      : [...form.scopes, scope])
  }

  const mutation = useMutation({
    mutationFn: (data) => api.post('/keys', data),
    onSuccess: (res) => onSuccess(res.data.rawKey),
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    mutation.mutate({
      ...form,
      expiresAt: form.expiresAt || undefined,
    })
  }

  const scopeInfo = {
    read: 'GET requests only',
    write: 'GET + POST + PUT + PATCH',
    admin: 'Full access including DELETE',
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
          <h3 className="font-semibold text-white">Generate API Key</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="label">Key Name *</label>
            <input className="input" value={form.name} required
                   onChange={e => set('name', e.target.value)}
                   placeholder="Production key for Payment Service" />
          </div>
          <div>
            <label className="label">Team *</label>
            <select className="input" value={form.teamId} required
                    onChange={e => set('teamId', e.target.value)}>
              <option value="">Select team...</option>
              {teamsData?.teams?.map(t => (
                <option key={t._id} value={t._id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Allowed APIs</label>
            <p className="text-xs text-gray-500 mb-2">Leave empty to allow access to all APIs</p>
            <div className="space-y-1.5 max-h-36 overflow-y-auto">
              {apisData?.apis?.map(a => (
                <label key={a._id} className="flex items-center gap-2 text-sm text-gray-300
                                               hover:text-white cursor-pointer p-2 rounded-lg
                                               hover:bg-gray-800 transition-colors">
                  <input type="checkbox" className="rounded border-gray-700 bg-gray-800"
                         checked={form.allowedApiIds.includes(a._id)}
                         onChange={() => toggleApi(a._id)} />
                  <span>{a.name}</span>
                  <span className="text-xs text-gray-500">{a.version}</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Scopes</label>
            <div className="grid grid-cols-3 gap-2">
              {Object.entries(scopeInfo).map(([scope, desc]) => (
                <label key={scope}
                       className={`flex flex-col gap-0.5 p-3 rounded-lg border cursor-pointer
                                   transition-all text-center
                                   ${form.scopes.includes(scope)
                                     ? 'border-brand-500 bg-brand-900/30 text-brand-300'
                                     : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'}`}>
                  <input type="checkbox" className="hidden"
                         checked={form.scopes.includes(scope)}
                         onChange={() => toggleScope(scope)} />
                  <span className="text-xs font-semibold capitalize">{scope}</span>
                  <span className="text-[10px] opacity-70">{desc}</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Expiry Date (optional)</label>
            <input type="datetime-local" className="input" value={form.expiresAt}
                   onChange={e => set('expiresAt', e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={mutation.isPending}
                    className="btn-primary flex items-center gap-2">
              {mutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Generate Key
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── STATUS BADGE ────────────────────────────────────────────────────────────
const statusBadge = {
  active:   'badge-green',
  rotating: 'badge-yellow',
  revoked:  'badge-red',
}

// ─── MAIN KEYS MANAGER ───────────────────────────────────────────────────────
export default function KeysManager() {
  const queryClient = useQueryClient()
  const addNotification = useUIStore(s => s.addNotification)
  const [showGenModal, setShowGenModal] = useState(false)
  const [revealedKey, setRevealedKey] = useState(null)
  const [filterTeam, setFilterTeam] = useState('')

  const { data: keysData, isLoading } = useQuery({
    queryKey: ['keys', filterTeam],
    queryFn: () => api.get(`/keys${filterTeam ? `?teamId=${filterTeam}` : ''}`).then(r => r.data),
    refetchInterval: 30_000,
  })

  const { data: teamsData } = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get('/teams').then(r => r.data),
  })

  const revokeMutation = useMutation({
    mutationFn: (keyId) => api.post(`/keys/${keyId}/revoke`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      addNotification({ type: 'success', title: 'Key Revoked', message: 'API key has been revoked immediately' })
    },
    onError: () => addNotification({ type: 'error', title: 'Revoke Failed' }),
  })

  const rotateMutation = useMutation({
    mutationFn: (keyId) => api.post(`/keys/${keyId}/rotate`, { rotationWindowMs: 86400000 }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      setRevealedKey(res.data.rawKey)
      addNotification({ type: 'info', title: 'Key Rotating', message: 'Old key valid for 24h. Save the new key now.' })
    },
  })

  const keys = keysData?.keys || []

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">API Keys</h2>
          <p className="text-sm text-gray-500 mt-0.5">{keys.length} keys</p>
        </div>
        <button onClick={() => setShowGenModal(true)} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Generate Key
        </button>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3">
        <select className="input max-w-xs" value={filterTeam} onChange={e => setFilterTeam(e.target.value)}>
          <option value="">All Teams</option>
          {teamsData?.teams?.map(t => <option key={t._id} value={t._id}>{t.name}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="card p-0 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="table-header">Key Name</th>
              <th className="table-header">Team</th>
              <th className="table-header">Scopes</th>
              <th className="table-header">Status</th>
              <th className="table-header">Last Used</th>
              <th className="table-header">Expires</th>
              <th className="table-header">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={7} className="text-center py-8 text-gray-500 text-sm">Loading...</td></tr>
            )}
            {!isLoading && keys.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center py-12">
                  <Key className="w-8 h-8 text-gray-600 mx-auto mb-2" />
                  <p className="text-gray-500 text-sm">No API keys yet</p>
                </td>
              </tr>
            )}
            {keys.map(k => (
              <tr key={k._id} className="border-b border-gray-800/50 hover:bg-gray-800/20 transition-colors">
                <td className="table-cell">
                  <div className="flex items-center gap-2">
                    <Key className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
                    <div>
                      <div className="text-white text-sm font-medium">{k.name}</div>
                      <div className="text-xs text-gray-600 font-mono">{k.keyPrefix}••••</div>
                    </div>
                  </div>
                </td>
                <td className="table-cell">{k.teamId?.name || '—'}</td>
                <td className="table-cell">
                  <div className="flex flex-wrap gap-1">
                    {k.scopes?.map(s => (
                      <span key={s} className="badge-blue capitalize">{s}</span>
                    ))}
                  </div>
                </td>
                <td className="table-cell">
                  <span className={statusBadge[k.status] || 'badge-gray'}>
                    {k.status}
                  </span>
                </td>
                <td className="table-cell text-gray-500">
                  {k.lastUsedAt ? format(new Date(k.lastUsedAt), 'MMM d, HH:mm') : 'Never'}
                </td>
                <td className="table-cell text-gray-500">
                  {k.expiresAt ? format(new Date(k.expiresAt), 'MMM d, yyyy') : '∞ Never'}
                </td>
                <td className="table-cell">
                  <div className="flex items-center gap-1">
                    {k.status === 'active' && (
                      <>
                        <button
                          onClick={() => rotateMutation.mutate(k._id)}
                          disabled={rotateMutation.isPending}
                          className="p-1.5 rounded-lg text-gray-500 hover:text-yellow-400
                                     hover:bg-yellow-900/20 transition-colors"
                          title="Rotate key"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Revoke "${k.name}"? This is immediate and irreversible.`)) {
                              revokeMutation.mutate(k._id)
                            }
                          }}
                          className="p-1.5 rounded-lg text-gray-500 hover:text-red-400
                                     hover:bg-red-900/20 transition-colors"
                          title="Revoke key"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showGenModal && (
        <GenerateKeyModal
          onClose={() => setShowGenModal(false)}
          onSuccess={(key) => {
            setShowGenModal(false)
            setRevealedKey(key)
            queryClient.invalidateQueries({ queryKey: ['keys'] })
          }}
        />
      )}

      {revealedKey && (
        <KeyRevealModal rawKey={revealedKey} onClose={() => setRevealedKey(null)} />
      )}
    </div>
  )
}
