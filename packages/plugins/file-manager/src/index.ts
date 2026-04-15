import { Plugin } from "@octopus-ai/core/dist/plugins/types.js";

const plugin: Plugin = {
  manifest: { description: "Official plugin", author: "Octopus", 
    name: "file-manager",
    version: "0.1.0",
  },
  onLoad: async () => {},
};

export default plugin;
