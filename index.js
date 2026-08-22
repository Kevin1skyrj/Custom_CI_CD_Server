import app from "./src/app.js";
import { PORT } from "./src/config/env.js";

app.listen(PORT, () => {
  console.log(`CI/CD server listening on port ${PORT}`);
});
