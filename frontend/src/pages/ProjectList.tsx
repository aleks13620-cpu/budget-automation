import { useState, useEffect } from 'react';
import { api } from '../api';

interface Project {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
}

interface Props {
  onSelect: (id: number, name: string) => void;
}

export function ProjectList({ onSelect }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/projects');
      setProjects(data);
      setError(null);
    } catch {
      setError('Не удалось загрузить список проектов');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await api.post('/projects', { name: newName.trim(), description: newDesc.trim() || null });
      setNewName('');
      setNewDesc('');
      await load();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка при создании проекта');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <h1>Проекты</h1>

      {error && <p className="error-msg">{error}</p>}

      <div className="inline-form">
        <div className="field">
          <label>Название</label>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Новый проект"
          />
        </div>
        <div className="field">
          <label>Описание</label>
          <input
            type="text"
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            placeholder="Описание (опционально)"
          />
        </div>
        <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>
          {creating ? 'Создание...' : 'Создать'}
        </button>
      </div>

      {loading ? (
        <p className="loading">Загрузка...</p>
      ) : projects.length === 0 ? (
        <p className="muted">Нет проектов. Создайте первый.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Название</th>
              <th>Описание</th>
              <th>Создан</th>
            </tr>
          </thead>
          <tbody>
            {projects.map(p => (
              <tr key={p.id} onClick={() => onSelect(p.id, p.name)} style={{ cursor: 'pointer' }}>
                <td>{p.name}</td>
                <td>{p.description || '—'}</td>
                <td>{new Date(p.created_at).toLocaleDateString('ru-RU')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
