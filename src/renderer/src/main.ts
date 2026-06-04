/** Renderer entry: load styles + boot the app shell. */
import './styles/design-system.css'
import './styles/app-shell.css'
import { bootApp } from './app'
import { byId } from './ui/dom'

bootApp(byId('app'))
