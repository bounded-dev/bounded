import { textValueLaws, valueObjectLaws } from "../shared/value-object.laws.test-support.ts";
import { Command } from "./command.ts";

valueObjectLaws("Command", Command, ["make build", " make\n\tbuild "], ["", " ", "rm a\0b", "echo \u001b[31m"]);
textValueLaws("Command", Command, [["make build", "make build"], [" make\n\tbuild ", " make\n\tbuild "]]);
