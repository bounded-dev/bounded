import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { NamePattern } from "./name-pattern.ts";

valueObjectLaws("NamePattern", NamePattern, ["*.ts", "**/*.{ts,tsx}"], ["", " "]);
textValueLaws("NamePattern", NamePattern, [["*.ts", "*.ts"]]);
