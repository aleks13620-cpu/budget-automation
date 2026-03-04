import { useState, useEffect } from 'react';
import { api } from '../api';

interface Trigger {
  id: number;
  keyword: string;
  from_unit: string | null;
  to_unit: string;
  description: string | null;
}

const EMPTY_FORM = { keyword: '', from_unit: '', to_unit: '', description: '' };

interface Props {
  onBack: () => void;
}

export function UnitTriggers({ onBack }: Props) {
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editId, setEditId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = async () => {
    const { data } = await api.get('/unit-conversion-triggers');
    setTriggers(data);
  };

  useEffect(() => { load(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.keyword.trim() || !form.to_unit.trim()) {
      setMessage({ type: 'error', text: 'Ключевое слово и ед. назначения обязательны' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const payload = {
        keyword: form.keyword.trim(),
        from_unit: form.from_unit.trim() || null,
        to_unit: form.to_unit.trim(),
        description: form.description.trim() || null,
      };
      if (editId !== null) {
        await api.put(`/unit-conversion-triggers/${editId}`, payload);
        setMessage({ type: 'success', text: 'Триггер обновлён' });
      } else {
        await api.post('/unit-conversion-triggers', payload);
        setMessage({ type: 'success', text: 'Триггер добавлен' });
      }
      setForm(EMPTY_FORM);
      setEditId(null);
      await load();
    } catch {
      setMessage({ type: 'error', text: 'Ошибка при сохранении' });
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (t: Trigger) => {
    setEditId(t.id);
    setForm({ keyword: t.keyword, from_unit: t.from_unit || '', to_unit: t.to_unit, description: t.description || '' });
    setMessage(null);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Удалить триггер?')) return;
    try {
      await api.delete(`/unit-conversion-triggers/${id}`);
      await load();
    } catch {
      setMessage({ type: 'error', text: 'Ошибка при удалении' });
    }
  };

  const handleCancel = () => {
    setEditId(null);
    setForm(EMPTY_FORM);
    setMessage(null);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>Триггеры пересчёта единиц</h2>
        <button className="btn btn-secondary" onClick={onBack}>Назад</button>
      </div>
      <p className="muted" style={{ marginBottom: '1rem' }}>
        Если наименование позиции содержит ключевое слово — позиция будет помечена для проверки единиц измерения.
      </p>

      {message && (
        <p className={message.type === 'success' ? 'success-msg' : 'error-msg'}>{message.text}</p>
      )}

      {/* Form */}
      <form onSubmit={handleSubmit} style={{ background: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: 6, padding: '1rem', marginBottom: '1.5rem' }}>
        <h3 style={{ margin: '0 0 0.75rem' }}>{editId !== null ? 'Редактировать триггер' : 'Добавить триггер'}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 2fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: 600 }}>Ключевое слово *</label>
            <input className="input" value={form.keyword} onChange={e => setForm(f => ({ ...f, keyword: e.target.value }))} placeholder="труба" />
          </div>
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: 600 }}>Ед. исходная</label>
            <input className="input" value={form.from_unit} onChange={e => setForm(f => ({ ...f, from_unit: e.target.value }))} placeholder="шт" />
          </div>
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: 600 }}>Ед. назначения *</label>
            <input className="input" value={form.to_unit} onChange={e => setForm(f => ({ ...f, to_unit: e.target.value }))} placeholder="м" />
          </div>
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: 600 }}>Описание</label>
            <input className="input" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Труба продаётся поштучно, нужна в метрах" />
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? 'Сохранение...' : editId !== null ? 'Сохранить' : 'Добавить'}
          </button>
          {editId !== null && (
            <button className="btn btn-secondary" type="button" onClick={handleCancel}>Отмена</button>
          )}
        </div>
      </form>

      {/* List */}
      {triggers.length === 0 ? (
        <p className="muted">Триггеры не добавлены</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Ключевое слово</th>
              <th>Из ед.</th>
              <th>В ед.</th>
              <th>Описание</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {triggers.map(t => (
              <tr key={t.id}>
                <td><strong>{t.keyword}</strong></td>
                <td>{t.from_unit || '—'}</td>
                <td>{t.to_unit}</td>
                <td className="muted" style={{ fontSize: '0.85rem' }}>{t.description || '—'}</td>
                <td>
                  <div style={{ display: 'flex', gap: '0.25rem' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => handleEdit(t)}>Изм.</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => handleDelete(t.id)}>Удал.</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
