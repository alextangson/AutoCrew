export default function Settings() {
  return (
    <div className="page" style={{ maxWidth: '600px' }}>
      <h1>设置</h1>

      <div className="card" style={{ marginBottom: '16px' }}>
        <h3>平台账号</h3>
        <p className="muted" style={{ fontSize: '0.85rem' }}>绑定社媒平台账号以启用一键发布</p>
        <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {['抖音', '小红书', 'B站', '微信公众号'].map((p) => (
            <div key={p} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.875rem' }}>{p}</span>
              <button className="btn btn-sm">绑定</button>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: '16px' }}>
        <h3>AI 配置</h3>
        <div className="format-setting" style={{ marginTop: '12px' }}>
          <div className="format-setting-label">豆包 App ID</div>
          <input type="text" placeholder="输入 App ID" style={{
            width: '100%', padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: '4px', color: 'var(--text)', fontSize: '0.85rem',
          }} />
        </div>
        <div className="format-setting" style={{ marginTop: '8px' }}>
          <div className="format-setting-label">豆包 Access Token</div>
          <input type="password" placeholder="输入 Access Token" style={{
            width: '100%', padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: '4px', color: 'var(--text)', fontSize: '0.85rem',
          }} />
        </div>
      </div>

      <div className="card">
        <h3>导出</h3>
        <div className="format-setting" style={{ marginTop: '12px' }}>
          <div className="format-setting-label">剪映草稿目录</div>
          <input type="text" placeholder="~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft" style={{
            width: '100%', padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: '4px', color: 'var(--text)', fontSize: '0.85rem',
          }} />
        </div>
      </div>
    </div>
  );
}
