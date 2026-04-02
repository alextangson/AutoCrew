import { Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Workflows from './pages/Workflows';
import Contents from './pages/Contents';
import Research from './pages/Research';

const navItems = [
  { to: '/', label: '仪表盘' },
  { to: '/workflows', label: '工作流' },
  { to: '/contents', label: '内容管理' },
  { to: '/research', label: '选题研究' },
];

export default function App() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-brand">AutoCrew</div>
        <nav>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/workflows" element={<Workflows />} />
          <Route path="/contents" element={<Contents />} />
          <Route path="/research" element={<Research />} />
        </Routes>
      </main>
    </div>
  );
}
