import { useNavigate } from 'react-router-dom';

interface Format {
  type: string;
  label: string;
  status: 'done' | 'active' | 'pending' | 'failed';
}

interface Props {
  id: string;
  title: string;
  formats: Format[];
}

export default function ContentCard({ id, title, formats }: Props) {
  const navigate = useNavigate();

  return (
    <div className="content-card" onClick={() => navigate(`/content/${id}`)}>
      <div className="content-card-title">{title}</div>
      {formats.length > 0 && (
        <div className="content-card-formats">
          {formats.map((f) => (
            <span key={f.type} className={`format-tag ${f.status}`}>
              {f.label} {f.status === 'done' ? '完成' : f.status === 'active' ? '生成中' : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
