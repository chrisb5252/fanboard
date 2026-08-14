export default function HomePage() {
  return (
    <main className="shell">
      <h1>FanBoard Backend</h1>
      <p className="lede">
        Infrastructure scaffold. No API routes are implemented yet.
      </p>
      <dl className="facts">
        <div>
          <dt>Runtime</dt>
          <dd>Next.js App Router</dd>
        </div>
        <div>
          <dt>Datastores</dt>
          <dd>PostgreSQL 15 · Redis 7</dd>
        </div>
        <div>
          <dt>Schema</dt>
          <dd>packages/backend/schema.sql</dd>
        </div>
      </dl>
    </main>
  );
}
