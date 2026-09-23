# How does a selection reach the agent?

Type: grilling
Status: open
Blocked by: 09

## Question

In M6 the viewer produces `{ sceneId, layerId, partId?, from, to }` plus prompt text and reference image paths. How does that payload get to the agent? Options include the clipboard, a file the MCP server reads, and an MCP resource. Consider what the user does next in their coding agent, and whether the viewer and the MCP server run as one process.
