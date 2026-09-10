import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/AuthContext'
import Layout from './components/Layout'
import RequirePermission from './components/RequirePermission'
import LoginPage from './pages/LoginPage'
import ContactsPage from './pages/ContactsPage'
import EventsPage from './pages/EventsPage'
import EventDetailPage from './pages/EventDetailPage'
import EventMatrixPage from './pages/EventMatrixPage'
import PressListPage from './pages/PressListPage'
import PressEditPage from './pages/PressEditPage'
import SchedulePage from './pages/SchedulePage'
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
        <Route
          path="/press"
          element={
            <RequirePermission need="viewPress">
              <PressListPage />
            </RequirePermission>
          }
        />
        <Route
          path="/press/:id"
          element={
            <RequirePermission need="viewPress">
              <PressEditPage />
            </RequirePermission>
          }
        />
        <Route
          path="/schedule"
          element={
            <RequirePermission need="viewPress">
              <SchedulePage />
            </RequirePermission>
          }
        />
        <Route
          path="/contacts"
          element={
            <RequirePermission need="manageContacts">
              <ContactsPage />
            </RequirePermission>
          }
        />
        <Route
          path="/events"
          element={
            <RequirePermission need="manageEvents">
              <EventsPage />
            </RequirePermission>
          }
        />
        <Route
          path="/events/matrix"
          element={
            <RequirePermission need="manageEvents">
              <EventMatrixPage />
            </RequirePermission>
          }
        />
        <Route
          path="/events/:id"
          element={
            <RequirePermission need="manageEvents">
              <EventDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="/send"
          element={
            <RequirePermission need="sendTest">
              <SendPage />
            </RequirePermission>
          }
        />
        <Route
          path="/campaigns"
          element={
            <RequirePermission need="viewCampaigns">
              <CampaignsPage />
            </RequirePermission>
          }
        />
        <Route
          path="/campaigns/:id"
          element={
            <RequirePermission need="viewCampaigns">
              <CampaignDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="/settings"
          element={
            <RequirePermission need="manageSettings">
              <SettingsPage />
            </RequirePermission>
          }
        />
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
