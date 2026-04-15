import { Plugin } from "@octopus-ai/core/dist/plugins/types.js";

const plugin: Plugin = {
  manifest: { description: "Official plugin", author: "Octopus", 
    name: "research",
    version: "0.1.0",
  },
  commands: [
    {
      name: "/search",
      description: "Search results",
      execute: async () => {
        return "Search results";
      },
    },
  ],
  onLoad: async () => {},
};

export default plugin;
