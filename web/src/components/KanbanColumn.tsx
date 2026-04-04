import ContentCard from './ContentCard';

interface ContentItem {
  id: string;
  title: string;
  formats: { type: string; label: string; status: 'done' | 'active' | 'pending' | 'failed' }[];
}

interface Props {
  title: string;
  items: ContentItem[];
}

export default function KanbanColumn({ title, items }: Props) {
  return (
    <div className="kanban-column">
      <div className="kanban-column-header">
        <span className="kanban-column-title">{title}</span>
        <span className="kanban-column-count">{items.length}</span>
      </div>
      <div className="kanban-cards">
        {items.map((item) => (
          <ContentCard key={item.id} {...item} />
        ))}
      </div>
    </div>
  );
}
