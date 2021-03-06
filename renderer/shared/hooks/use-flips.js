import React, {useState, useEffect, useCallback} from 'react'
import * as api from '../api/dna'
import {useEpochState} from '../providers/epoch-context'
import {useInterval} from './use-interval'
import {fetchTx} from '../api'
import {HASH_IN_MEMPOOL} from './use-tx'
import {areSame, areEual} from '../utils/arr'
import {didValidate} from '../../screens/validation/utils'
import {FlipType} from '../types'
import {
  didArchiveFlips,
  markFlipsArchived,
  flipToHex,
} from '../../screens/flips/utils/flip'

const {
  getFlips: getFlipsFromStore,
  getFlip: getFlipFromStore,
  saveFlips,
  deleteDraft: deleteFromStore,
} = global.flipStore || {}

const FLIP_MAX_SIZE = 1024 * 1024 // 1 mb
const DEFAULT_ORDER = [0, 1, 2, 3]

export const FLIP_LENGTH = DEFAULT_ORDER.length

function useFlips() {
  const [flips, setFlips] = useState([])

  useEffect(() => {
    const savedFlips = getFlipsFromStore()
    if (savedFlips.length) {
      setFlips(savedFlips)
    }
  }, [])

  useInterval(
    async () => {
      const txPromises = flips
        .filter(
          f => f.type === FlipType.Publishing || f.type === FlipType.Deleting
        )
        .map(f => (f.type === FlipType.Publishing ? f.txHash : f.deleteTxHash))
        .map(fetchTx)
      await Promise.all(txPromises).then(txs => {
        const pendingFlips = flips.filter(
          f => f.type === FlipType.Publishing || f.type === FlipType.Deleting
        )
        const otherFlips = flips.filter(
          f => f.type !== FlipType.Publishing && f.type !== FlipType.Deleting
        )
        const nextFlips = pendingFlips
          .map(flip => {
            const tx = txs.find(
              ({hash}) =>
                hash &&
                ((flip.type === FlipType.Publishing && hash === flip.txHash) ||
                  hash === flip.deleteTxHash)
            )
            const type = checkFlipType(flip, tx)
            return {
              ...flip,
              mined: type === FlipType.Published,
              type,
            }
          })
          .concat(otherFlips)
        setFlips(nextFlips)
        saveFlips(nextFlips)
      })
    },
    flips.some(
      ({type}) => type === FlipType.Publishing || type === FlipType.Deleting
    )
      ? 1000 * 10
      : null
  )

  const getDraft = useCallback(
    id => flips.find(f => f.id === id) || getFlipFromStore(id),
    [flips]
  )

  const saveDraft = useCallback(draft => {
    setFlips(prevFlips => {
      const draftIdx = prevFlips.findIndex(
        f => f.id === draft.id && f.type === FlipType.Draft
      )
      const nextDraft = {...draft, type: FlipType.Draft}
      const nextFlips =
        draftIdx > -1
          ? [
              ...prevFlips.slice(0, draftIdx),
              {...prevFlips[draftIdx], ...nextDraft, modifiedAt: Date.now()},
              ...prevFlips.slice(draftIdx + 1),
            ]
          : prevFlips.concat({...nextDraft, createdAt: Date.now()})

      saveFlips(nextFlips)

      return nextFlips
    })
  }, [])

  const submitFlip = useCallback(
    async ({id, pics, compressedPics, order, hint}) => {
      if (
        flips.filter(
          f =>
            f.type === FlipType.Published &&
            f.compressedPics &&
            areSame(f.compressedPics, compressedPics)
        ).length > 0
      ) {
        return {
          error: {message: 'You already submitted this flip'},
        }
      }
      if (areEual(order, DEFAULT_ORDER)) {
        return {
          error: {message: 'You must shuffle flip before submit'},
        }
      }
      if (!hint) {
        return {
          error: {message: 'Keywords for flip are not specified'},
        }
      }

      const pairId = hint.id

      if (pairId < 0) {
        return {
          error: {message: 'Keywords for flip are not allowed'},
        }
      }

      const [hex, publicHex, privateHex] = flipToHex(compressedPics, order)
      if (publicHex.length + privateHex.length > 2 * FLIP_MAX_SIZE) {
        return {
          error: {message: 'Flip is too large'},
        }
      }

      const resp = await api.submitFlip(
        hex,
        publicHex,
        privateHex,
        Math.max(0, pairId)
      )
      const {result} = resp
      if (result) {
        setFlips(prevFlips => {
          const flipIdx = prevFlips.findIndex(f => f.id === id)
          const nextFlips = [
            ...prevFlips.slice(0, flipIdx),
            {
              ...prevFlips[flipIdx],
              id,
              pics,
              compressedPics,
              order,
              ...result,
              type: FlipType.Publishing,
              modifiedAt: Date.now(),
            },
            ...prevFlips.slice(flipIdx + 1),
          ]

          saveFlips(nextFlips)

          return nextFlips
        })
      }
      return resp
    },
    [flips]
  )

  const deleteFlip = useCallback(
    async ({id}) => {
      const flip = getDraft(id)
      if (flip.type === FlipType.Published) {
        const resp = await api.deleteFlip(flip.hash)
        const {result} = resp
        if (result) {
          setFlips(prevFlips => {
            const flipIdx = prevFlips.findIndex(f => f.id === id)
            const nextFlips = [
              ...prevFlips.slice(0, flipIdx),
              {
                ...prevFlips[flipIdx],
                type: FlipType.Deleting,
                deleteTxHash: result,
                modifiedAt: Date.now(),
              },
              ...prevFlips.slice(flipIdx + 1),
            ]
            saveFlips(nextFlips)
            return nextFlips
          })
        }
        return resp
      }
      deleteFromStore(id)
      setFlips(prevFlips => prevFlips.filter(f => f.id !== id))
      return {}
    },
    [getDraft]
  )

  // eslint-disable-next-line no-shadow
  const archiveFlips = useCallback(epoch => {
    setFlips(prevFlips => {
      const nextFlips = prevFlips.map(flip => ({
        ...flip,
        type: FlipType.Archived,
      }))
      saveFlips(nextFlips)
      return nextFlips
    })
    markFlipsArchived(epoch)
  }, [])

  const epoch = useEpochState()

  React.useEffect(() => {
    if (epoch && didValidate(epoch.epoch) && !didArchiveFlips(epoch.epoch)) {
      archiveFlips(epoch.epoch)
    }
  }, [archiveFlips, epoch])

  return {
    flips,
    getDraft,
    saveDraft,
    submitFlip,
    deleteFlip,
    archiveFlips,
  }
}

function checkFlipType(flip, tx) {
  if (flip.type === FlipType.Publishing) {
    const txExists = tx && tx.result
    if (!txExists) return FlipType.Draft
    return txExists && tx.result.blockHash !== HASH_IN_MEMPOOL
      ? FlipType.Published
      : flip.type
  }
  if (flip.type === FlipType.Deleting) {
    const txExists = tx && tx.result
    if (!txExists) return FlipType.Published
    return txExists && tx.result.blockHash !== HASH_IN_MEMPOOL
      ? FlipType.Draft
      : flip.type
  }
  return flip.type
}

export default useFlips
