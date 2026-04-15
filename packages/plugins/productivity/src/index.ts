import { Plugin } from "@octopus-ai/core/dist/plugins/types.js";

const plugin: Plugin = {
  manifest: { description: "Official plugin", author: "Octopus", 
    name: "productivity",
    version: "0.1.0",
  },
  commands: [
    {
      name: "/task-add",
      description: "Add a task",
      execute: async () => {
        return "Task added";
      },
    },
  ],
  onLoad: async () => {},
};

export default plugin;
