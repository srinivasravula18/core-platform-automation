import type { Request, Response, NextFunction } from 'express';

export function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
