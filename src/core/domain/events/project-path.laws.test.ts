import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { ProjectPath } from "./project-path.ts";

valueObjectLaws("ProjectPath", ProjectPath, ["src/a.ts", "."], ["", "/etc/passwd", "../x", "a/../../x", "C:/x", "a\\b", "~/x"]);
textValueLaws("ProjectPath", ProjectPath, [["src/a.ts", "src/a.ts"], ["./src//a.ts", "src/a.ts"], ["src/..", "."]]);
