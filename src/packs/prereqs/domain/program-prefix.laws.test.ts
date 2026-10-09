import { valueObjectLaws } from "../../../core/domain/shared/value-object.laws.test-support.ts";
import { ProgramPrefix } from "./program-prefix.ts";

valueObjectLaws("ProgramPrefix", ProgramPrefix, ["terraform apply", "git push", "make"], ["", "$TF apply", "./deploy.sh", "terraform -auto-approve", "terraform\tapply"]);
