import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectManagementRouter } from "@example/project-management/adapters/trpc";

// Type-only import: the client gets the router's types, none of its server code.
const api = createTRPCClient<ProjectManagementRouter>({ links: [httpBatchLink({ url: "/trpc" })] });

type Project = Awaited<ReturnType<typeof api.projects.list.query>>[number];

function App() {
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    api.projects.list.query().then(setProjects);
  }, []);

  return (
    <main>
      <h1>Projects</h1>
      <ul>
        {projects.map((project) => (
          <li key={project.id}>{project.name}</li>
        ))}
      </ul>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
