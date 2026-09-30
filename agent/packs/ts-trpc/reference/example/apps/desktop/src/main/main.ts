import { app, BrowserWindow } from "electron";
import path from "node:path";
import { composeApp } from "./composition-root.ts";

const api = composeApp().createCaller({});

app.whenReady().then(async () => {
  const project = await api.projects.create({ name: "My first project" });
  if (project.ok) await api.notes.create({ projectId: project.value.id, text: "My first note" });
  console.log(await api.projects.list(), await api.notes.list());

  const window = new BrowserWindow({ width: 1000, height: 700 });
  window.loadFile(path.join(__dirname, "../renderer/index.html"));
});
