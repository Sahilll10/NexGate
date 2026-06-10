// src/components/APIs/APICatalogue.jsx
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Search, Plus, Globe, ExternalLink, Tag, X, Loader2 } from 'lucide-react'
import api from '../../services/api.js'
import { useUIStore } from '../../store/index.js'

// ─── REGISTER API MODAL ──────────────────────────────────────────────────────
function RegisterApiModal({ onClose }) {
  const queryClient = useQueryClient()
  const addNotification = useUIStore(s => s.addNotification)
  const [form, setForm] = useState({
    name: '', description: '', version: 'v1', targetBaseUrl: '',
    tags: '', ownerTeamId: '', timeoutMs: 30000,
  })

  const { data: teamsData } = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get('/teams').then(r => r.data),
  })

  const mutation = useMutation({
    mutationFn: (data) => api.post('/apis', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      addNotification({ type: 'success', title: 'API Registered', message: `${form.name} added to catalogue` })
      onClose()
    },
    onError: (err) => {
      addNotification({ type: 'error', title: 'Failed', message: err.response?.data?.details || 'Registration failed' })
    },
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    mutation.mutate({
      ...form,
      tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
      timeoutMs: Number(form.timeoutMs),
    })
  }

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h3 className="font-semibold text-white">Register New API</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="label">API Name *</label>
              <input className="input" value={form.name} onChange={e => set('name', e.target.value)}
                     placeholder="Payment Service" required />
            </div>
            <div>
              <label className="label">Version</label>
              <input className="input" value={form.version} onChange={e => set('version', e.target.value)}
                     placeholder="v1" />
            </div>
            <div>
              <label className="label">Timeout (ms)</label>
              <input className="input" type="number" value={form.timeoutMs}
                     onChange={e => set('timeoutMs', e.target.value)} />
            </div>
            <div className="col-span-2">
              <label className="label">Target Base URL *</label>
              <input className="input" value={form.targetBaseUrl}
                     onChange={e => set('targetBaseUrl', e.target.value)}
                     placeholder="https://payment-service.internal:8080" required />
            </div>
            <div className="col-span-2">
              <label className="label">Owner Team *</label>
              <select className="input" value={form.ownerTeamId}
                      onChange={e => set('ownerTeamId', e.target.value)} required>
                <option value="">Select team...</option>
                {teamsData?.teams?.map(t => (
                  <option key={t._id} value={t._id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="label">Description</label>
              <textarea className="input" rows={2} value={form.description}
                        onChange={e => set('description', e.target.value)}
                        placeholder="What does this API do?" />
            </div>
            <div className="col-span-2">
              <label className="label">Tags (comma separated)</label>
              <input className="input" value={form.tags} onChange={e => set('tags', e.target.value)}
                     placeholder="payments, finance, internal" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={mutation.isPending}
                    className="btn-primary flex items-center gap-2">
              {mutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Register API
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── API CARD ─────────────────────────────────────────────────────────────────
function ApiCard({ apiDoc }) {
  return (
    <Link to={`/apis/${apiDoc._id}`} className="block">
      <div className="card hover:border-brand-700/50 hover:bg-gray-800/50 transition-all cursor-pointer group">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-brand-600/20 flex items-center justify-center flex-shrink-0">
              <Globe className="w-4 h-4 text-brand-400" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-white group-hover:text-brand-300 transition-colors truncate">
                {apiDoc.name}
              </div>
              <div className="text-xs text-gray-500">{apiDoc.version}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {apiDoc.isActive ? (
              <span className="badge-green">Active</span>
            ) : (
              <span className="badge-gray">Inactive</span>
            )}
            <ExternalLink className="w-3.5 h-3.5 text-gray-600 group-hover:text-gray-400 transition-colors" />
          </div>
        </div>

        {apiDoc.description && (
          <p className="text-xs text-gray-500 mb-3 line-clamp-2">{apiDoc.description}</p>
        )}

        <div className="flex items-center justify-between">
          <div className="flex flex-wrap gap-1">
            {apiDoc.tags?.slice(0, 3).map(tag => (
              <span key={tag} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5
                                         bg-gray-800 text-gray-400 rounded border border-gray-700">
                <Tag className="w-2.5 h-2.5" />
                {tag}
              </span>
            ))}
          </div>
          <div className="text-xs text-gray-600 truncate max-w-[120px]" title={apiDoc.targetBaseUrl}>
            {apiDoc.targetBaseUrl?.replace(/https?:\/\//, '')}
          </div>
        </div>
      </div>
    </Link>
  )
}

// ─── MAIN CATALOGUE ──────────────────────────────────────────────────────────
export default function APICatalogue() {
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [debouncedSearch, setDebouncedSearch] = useState('')

  // Debounce search input
  const handleSearchChange = (val) => {
    setSearch(val)
    clearTimeout(window._searchDebounce)
    window._searchDebounce = setTimeout(() => setDebouncedSearch(val), 400)
  }

  const { data, isLoading } = useQuery({
    queryKey: ['apis', debouncedSearch],
    queryFn: () => api.get(`/apis?search=${encodeURIComponent(debouncedSearch)}&limit=50`).then(r => r.data),
  })

  const apis = data?.apis || []

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">API Catalogue</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {data?.total ?? '—'} APIs registered
          </p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Register API
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          className="input pl-9 max-w-md"
          placeholder="Search by name, description, or tags..."
          value={search}
          onChange={e => handleSearchChange(e.target.value)}
        />
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="card animate-pulse">
              <div className="h-4 bg-gray-800 rounded w-3/4 mb-2" />
              <div className="h-3 bg-gray-800 rounded w-full mb-1" />
              <div className="h-3 bg-gray-800 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : apis.length === 0 ? (
        <div className="card text-center py-16">
          <Globe className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">No APIs found</p>
          <p className="text-gray-600 text-sm mt-1">
            {debouncedSearch ? 'Try a different search term' : 'Register your first API to get started'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {apis.map(a => <ApiCard key={a._id} apiDoc={a} />)}
        </div>
      )}

      {showModal && <RegisterApiModal onClose={() => setShowModal(false)} />}
    </div>
  )
}
