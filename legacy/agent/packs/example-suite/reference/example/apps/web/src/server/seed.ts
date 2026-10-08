import type { ProjectManagementRouter } from "@example/project-management/adapters/trpc";

// Dev data, created through the API so it passes the same validation as real requests.
export async function seed(router: ProjectManagementRouter): Promise<void> {
  const api = router.createCaller({});
  for (const name of ["Website redesign", "Mobile app", "Q4 planning"]) {
    await api.projects.create({ name });
  }
}
