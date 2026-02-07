import { useState } from 'react';
import './App.css';
import { ProjectList } from './pages/ProjectList';
import { ProjectDetail } from './pages/ProjectDetail';
import { InvoicePreview } from './pages/InvoicePreview';

type Page = 'projects' | 'project' | 'invoice-preview';

function App() {
  const [page, setPage] = useState<Page>('projects');
  const [projectId, setProjectId] = useState<number | null>(null);
  const [projectName, setProjectName] = useState('');
  const [invoiceId, setInvoiceId] = useState<number | null>(null);

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

  return (
    <>
      {/* Breadcrumbs */}
      <div className="breadcrumbs">
        <button onClick={goToProjects}>Проекты</button>
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
      </div>

      {page === 'projects' && (
        <ProjectList onSelect={goToProject} />
      )}

      {page === 'project' && projectId && (
        <ProjectDetail
          projectId={projectId}
          onBack={goToProjects}
          onInvoicePreview={goToInvoicePreview}
        />
      )}

      {page === 'invoice-preview' && invoiceId && (
        <InvoicePreview
          invoiceId={invoiceId}
          onBack={() => goToProject(projectId!, projectName)}
        />
      )}
    </>
  );
}

export default App;
