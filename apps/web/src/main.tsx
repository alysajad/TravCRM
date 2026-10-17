import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import '@fontsource/spectral/latin-400.css'
import '@fontsource/spectral/latin-600.css'
import '@fontsource/karla/latin-400.css'
import '@fontsource/karla/latin-500.css'
import '@fontsource/karla/latin-600.css'
import '@fontsource/karla/latin-700.css'
import './styles.css'
import './theme.css'

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserRouter><App /></BrowserRouter></React.StrictMode>)
