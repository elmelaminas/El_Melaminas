import Sidebar from '@/components/layout/Sidebar';
import Header from '@/components/layout/Header';

export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-app)' }}>
      <Sidebar />
      <div style={{ marginLeft: 'var(--sidebar-width)' }}>
        <Header />
        <main className="px-6 py-6 lg:px-8 lg:py-8 animate-fade">{children}</main>
      </div>
    </div>
  );
}
