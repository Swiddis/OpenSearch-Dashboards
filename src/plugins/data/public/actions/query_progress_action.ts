/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * The OpenSearch Contributors require contributions made to
 * this file be licensed under the Apache-2.0 license or a
 * compatible open source license.
 *
 * Any modifications Copyright OpenSearch Contributors. See
 * GitHub history for details.
 */

import { Subject } from 'rxjs';
import { UiActionsStart, createAction } from '../../../ui_actions/public';
import { ASYNC_TRIGGER_ID, ASYNC_ACTION_ID } from '../../common';

export interface AsyncQueryContext {
  queryId: string;
  queryStatus: string;
}

export function createQueryProgressSubject(uiActions: UiActionsStart): Subject<AsyncQueryContext> {
  const subject: Subject<AsyncQueryContext> = new Subject();
  uiActions.addTriggerAction(
    ASYNC_TRIGGER_ID,
    createAction<typeof ASYNC_ACTION_ID>({
      id: ASYNC_ACTION_ID,
      execute: async (context: unknown) => subject.next(context as AsyncQueryContext),
    })
  );
  return subject;
}
