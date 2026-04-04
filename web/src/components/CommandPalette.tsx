import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const commands = [
    { label: '发现选题', action: () => navigate('/') },
    { label: '我的内容', action: () => navigate('/content') },
    { label: '发布中心', action: () => navigate('/publish') },
    { label: '设置', action: () => navigate('/settings') },
  ];

  const filtered = commands.filter((c) => c.label.includes(query));

  function run(cmd: typeof commands[0]) {
    cmd.action();
    setOpen(false);
    setQuery('');
  }

  return (
    <>
      <button className="topbar-link" onClick={() => setOpen(true)}>
        Cmd+K
      </button>
      {open && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '20vh', zIndex: 100,
        }} onClick={() => setOpen(false)}>
          <div style={{
            width: '400px', background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: '10px', overflow: 'hidden',
          }} onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              placeholder="搜索命令..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                width: '100%', padding: '12px 16px', background: 'none', border: 'none',
                borderBottom: '1px solid var(--border)', color: 'var(--text)', fontSize: '0.9rem', outline: 'none',
              }}
            />
            <div style={{ maxHeight: '240px', overflowY: 'auto' }}>
              {filtered.map((cmd) => (
                <div
                  key={cmd.label}
                  onClick={() => run(cmd)}
                  style={{
                    padding: '10px 16px', cursor: 'pointer', fontSize: '0.875rem',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                >
                  {cmd.label}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
