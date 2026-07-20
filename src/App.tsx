import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/AuthContext'
import Layout from './components/Layout'
import LoginPage from './pages/LoginPage'
import ContactsPage from './pages/ContactsPage'
import EventsPage from './pages/EventsPage'
import EventDetailPage from './pages/EventDetailPage'
import PressListPage from './pages/PressListPage'
import PressEditPage from './pages/PressEditPage'
import SendPage from './pages/SendPage'
import CampaignsPage from './pages/CampaignsPage'
import CampaignDetailPage from './pages/CampaignDetailPage'
import SettingsPage from './pages/SettingsPage'

function Shell() {
  const { appUser, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-400">
        載入中…
      </div>
    )
  }

  if (!appUser) return <LoginPage />

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/press" replace />} />
        <Route path="/press" element={<PressListPage />} />
        <Route path="/press/:id" element={<PressEditPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/events/:id" element={<EventDetailPage />} />
        <Route path="/send" element={<SendPage />} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/campaigns/:id" element={<CampaignDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/press" replace />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </AuthProvider>
  )
}
