import AppShell from '@/components/layout/AppShell';

export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // El layout-level Server Component delega todo al AppShell client
  // wrapper, que gestiona el state del drawer móvil. El padding/margin
  // responsive vive en AppShell para que pueda variar con el state.
  return <AppShell>{children}</AppShell>;
}
