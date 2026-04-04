import { Routes, Route, NavLink } from 'react-router-dom';
import Discover from './pages/Discover';
import ContentBoard from './pages/ContentBoard';
import Editor from './pages/Editor';
import Publish from './pages/Publish';
import Settings from './pages/Settings';
import CommandPalette from './components/CommandPalette';

const navItems = [
  { to: '/', label: '发现' },
  { to: '/content', label: '内容' },
  { to: '/publish', label: '发布' },
];

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-brand">AutoCrew</span>
        <nav className="topbar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `topbar-link${isActive ? ' active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          <CommandPalette />
          <NavLink to="/settings" className={({ isActive }) => `topbar-link${isActive ? ' active' : ''}`}>
            设置
          </NavLink>
        </div>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Discover />} />
          <Route path="/content" element={<ContentBoard />} />
          <Route path="/content/:contentId" element={<Editor />} />
          <Route path="/publish" element={<Publish />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
