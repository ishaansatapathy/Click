import '@fontsource/kode-mono/400.css';
import '@fontsource/kode-mono/500.css';
import '@fontsource/space-mono/400.css';
import '@fontsource/space-mono/700.css';
import '@fontsource/pixelify-sans/400.css';
import './base.css';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth.js';
import Landing from './landing/Landing.js';

const SignIn = lazy(() => import('./signin/SignIn.js'));
const Shell = lazy(() => import('./app/Shell.js'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<div className="boot">Loading…</div>}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/sign-in" element={<SignIn />} />
            <Route
              path="/app/*"
              element={
                <RequireAuth>
                  <Shell />
                </RequireAuth>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
