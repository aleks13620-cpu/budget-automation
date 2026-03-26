import { useState } from 'react';
import './App.css';
import { ProjectList } from './pages/ProjectList';
import { ProjectDetail } from './pages/ProjectDetail';
import { InvoicePreview } from './pages/InvoicePreview';
import { MatchingView } from './pages/MatchingView';
import { UnitTriggers } from './pages/UnitTriggers';
import { SpecificationEditor } from './pages/SpecificationEditor';
import { FeedbackPage } from './pages/FeedbackPage';
import { GlobalFeedbackPage } from './pages/GlobalFeedbackPage';

type Page = 'projects' | 'project' | 'invoice-preview' | 'matching' | 'unit-triggers' | 'spec-editor' | 'feedback' | 'feedback-all';

function App() {
  const [page, setPage] = useState<Page>('projects');
  const [projectId, setProjectId] = useState<number | null>(null);
  const [projectName, setProjectName] = useState('');
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const [specId, setSpecId] = useState<number | null>(null);

  const goToProjects = () => {
    setPage('projects');
    setProjectId(null);
    setInvoiceId(null);
  };

  const goToProject = (id: number, name: string) => {
    setProjectId(id);
    setProjectName(name);
    setInvoiceId(null);
    setPage('project');
  };

  const goToInvoicePreview = (id: number) => {
    setInvoiceId(id);
    setPage('invoice-preview');
  };

  const goToMatching = () => {
    setPage('matching');
  };

  const goToUnitTriggers = () => {
    setPage('unit-triggers');
  };

  const goToSpecEditor = (id: number) => {
    setSpecId(id);
    setPage('spec-editor');
  };

  const goToFeedback = () => {
    setPage('feedback');
  };

  const goToFeedbackAll = () => {
    setPage('feedback-all');
  };

  return (
    <>
      {/* Breadcrumbs */}
      <div className="breadcrumbs">
        <button onClick={goToProjects}>Проекты</button>
        <span style={{ marginLeft: 'auto' }}>
          <button className="btn btn-secondary btn-sm" onClick={goToUnitTriggers} style={{ fontSize: '0.75rem' }}>
            ⚙ Триггеры единиц
          </button>
          <button className="btn btn-secondary btn-sm" onClick={goToFeedbackAll} style={{ fontSize: '0.75rem', marginLeft: '0.25rem' }}>
            ⚠ Замечания
          </button>
          {projectId && (
            <button className="btn btn-secondary btn-sm" onClick={goToFeedback} style={{ fontSize: '0.75rem', marginLeft: '0.25rem' }}>
              📊 Обучение
            </button>
          )}
        </span>
        {page !== 'projects' && (
          <>
            <span>/</span>
            <button onClick={() => goToProject(projectId!, projectName)}>{projectName}</button>
          </>
        )}
        {page === 'invoice-preview' && (
          <>
            <span>/</span>
            <span>Предпросмотр счёта</span>
          </>
        )}
        {page === 'matching' && (
          <>
            <span>/</span>
            <span>Сопоставление</span>
          </>
        )}
        {page === 'spec-editor' && (
          <>
            <span>/</span>
            <span>Редактор спецификации</span>
          </>
        )}
      </div>

      {page === 'projects' && (
        <ProjectList onSelect={goToProject} />
      )}

      {page === 'project' && projectId && (
        <ProjectDetail
          projectId={projectId}
          onBack={goToProjects}
          onInvoicePreview={goToInvoicePreview}
          onMatching={goToMatching}
          onSpecEditor={goToSpecEditor}
        />
      )}

      {page === 'invoice-preview' && invoiceId && (
        <InvoicePreview
          invoiceId={invoiceId}
          onBack={() => goToProject(projectId!, projectName)}
        />
      )}

      {page === 'matching' && projectId && (
        <MatchingView
          projectId={projectId}
          onBack={() => goToProject(projectId!, projectName)}
        />
      )}

      {page === 'unit-triggers' && (
        <UnitTriggers onBack={goToProjects} />
      )}

      {page === 'feedback' && projectId && (
        <FeedbackPage
          projectId={projectId}
          onBack={() => goToProject(projectId!, projectName)}
        />
      )}

      {page === 'feedback-all' && (
        <GlobalFeedbackPage
          onBack={goToProjects}
          onGoToProject={goToProject}
        />
      )}

      {page === 'spec-editor' && specId && (
        <SpecificationEditor
          specId={specId}
          onBack={() => goToProject(projectId!, projectName)}
        />
      )}
    </>
  );
}

export default App;
