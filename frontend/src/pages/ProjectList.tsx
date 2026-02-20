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
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');

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

  const handleDelete = async (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    if (!confirm(`Удалить проект «${project.name}» и все его данные (спецификации, счета, сопоставления)?`)) return;
    setError(null);
    try {
      await api.delete(`/projects/${project.id}`);
      await load();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка при удалении проекта');
    }
  };

  const startEdit = (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    setEditingId(project.id);
    setEditName(project.name);
    setEditDesc(project.description || '');
  };

  const handleSaveEdit = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!editName.trim() || !editingId) return;
    setError(null);
    try {
      await api.put(`/projects/${editingId}`, { name: editName.trim(), description: editDesc.trim() || null });
      setEditingId(null);
      await load();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка при сохранении');
    }
  };

  const cancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(null);
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
              <th style={{ width: '180px' }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {projects.map(p => (
              <tr key={p.id} onClick={() => editingId !== p.id && onSelect(p.id, p.name)} style={{ cursor: editingId === p.id ? 'default' : 'pointer' }}>
                {editingId === p.id ? (
                  <>
                    <td>
                      <input
                        type="text"
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        style={{ width: '100%', padding: '4px' }}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={editDesc}
                        onChange={e => setEditDesc(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        style={{ width: '100%', padding: '4px' }}
                      />
                    </td>
                    <td>{new Date(p.created_at).toLocaleDateString('ru-RU')}</td>
                    <td>
                      <span style={{ display: 'flex', gap: '0.25rem' }}>
                        <button className="btn btn-primary btn-sm" onClick={handleSaveEdit}>Сохранить</button>
                        <button className="btn btn-secondary btn-sm" onClick={cancelEdit}>Отмена</button>
                      </span>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{p.name}</td>
                    <td>{p.description || '—'}</td>
                    <td>{new Date(p.created_at).toLocaleDateString('ru-RU')}</td>
                    <td>
                      <span style={{ display: 'flex', gap: '0.25rem' }}>
                        <button className="btn btn-secondary btn-sm" onClick={(e) => startEdit(e, p)}>Изменить</button>
                        <button className="btn btn-secondary btn-sm" style={{ color: '#dc2626' }} onClick={(e) => handleDelete(e, p)}>Удалить</button>
                      </span>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
