import { Router, type IRouter } from "express";
import healthRouter from "./health";
import statsRouter from "./stats";
import authRouter from "./auth";
import vaultRouter from "./vault";
import projectsRouter from "./projects";
import transactionsRouter from "./transactions";
import reposRouter from "./repos";
import webhookRouter from "./webhook";
import autogitRouter from "./autogit";
import tokensRouter from "./tokens";
import contestRouter from "./contest";

const router: IRouter = Router();

router.use(healthRouter);
router.use(statsRouter);
router.use(tokensRouter);
router.use(authRouter);
router.use(vaultRouter);
router.use(projectsRouter);
router.use(transactionsRouter);
router.use(reposRouter);
router.use(autogitRouter);
router.use(contestRouter);
router.use(webhookRouter);

export default router;
