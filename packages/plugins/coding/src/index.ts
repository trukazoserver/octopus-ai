import { Plugin } from "@octopus-ai/core/dist/plugins/types.js";

const plugin: Plugin = {
  manifest: { description: "Official plugin", author: "Octopus", 
    name: "coding",
    version: "0.1.0",
  },
  commands: [
    {
      name: "/refactor",
      description: "Refactor code",
      execute: async () => {
        return "Refactored code";
      },
    },
  ],
  onLoad: async () => {},
};

export default plugin;
