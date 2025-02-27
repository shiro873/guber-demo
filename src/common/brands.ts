import { Job } from "bullmq"
import { countryCodes, dbServers, EngineType } from "../config/enums"
import { ContextType } from "../libs/logger"
import { jsonOrStringForDb, jsonOrStringToJson, stringOrNullForDb, stringToHash } from "../utils"
import _, { deburr } from "lodash"
import { sources } from "../sites/sources"
import items from "./../../pharmacyItems.json"
import connections from "./../../brandConnections.json"
import { CAPITALIZED, FRONT_OR_SECOND_WORDS, FRONT_WORDS, WORDS_TO_IGNORE } from "./constants"
import path from "path"
import * as fs from 'fs'

type BrandsMapping = {
    [key: string]: string[]
}

function getWordsArray(str: string) {
    return str.split(" ") || []
}

function getUniqueRows(mapping: BrandsMapping): BrandsMapping {
    const seenValues = new Set<string>(); // Track seen values
    const unique: BrandsMapping = {};

    for (const [key, value] of Object.entries(mapping)) {
        const valueString = JSON.stringify(value.sort()); // Sort and stringify for comparison

        if (!seenValues.has(valueString)) {
            // If this value hasn't been seen before, add it to the result
            seenValues.add(valueString);
            unique[key] = value;
        }
    }

    return unique;
}

export async function getBrandsMapping(): Promise<BrandsMapping> {
    const brandConnections = connections

    const getRelatedBrands = (map: Map<string, Set<string>>, brand: string): Set<string> => {
        const relatedBrands = new Set<string>()
        const queue = [brand]
        while (queue.length > 0) {
            const current = queue.pop()!
            if (map.has(current)) {
                const brands = map.get(current)!
                for (const b of brands) {
                    if (!relatedBrands.has(b)) {
                        relatedBrands.add(b)
                        queue.push(b)
                    }
                }
            }
        }
        return relatedBrands
    }

    // Create a map to track brand relationships
    const brandMap = new Map<string, Set<string>>()

    brandConnections.forEach(({ manufacturer_p1, manufacturers_p2 }) => {
        const brand1 = manufacturer_p1.toLowerCase()
        const brands2 = manufacturers_p2.toLowerCase()
        const brand2Array = brands2.split(";").map((b) => b.trim())
        if (!brandMap.has(brand1)) {
            brandMap.set(brand1, new Set())
        }
        brand2Array.forEach((brand2) => {
            if (!brandMap.has(brand2)) {
                brandMap.set(brand2, new Set())
            }
            brandMap.get(brand1)!.add(brand2)
            brandMap.get(brand2)!.add(brand1)
        })
    })

    // Build the final flat map
    const flatMap = new Map<string, Set<string>>()

    brandMap.forEach((_, brand) => {
        const relatedBrands = getRelatedBrands(brandMap, brand)
        flatMap.set(brand, relatedBrands)
    })

    // Convert the flat map to an object for easier usage
    const flatMapObject: Record<string, string[]> = {}

    flatMap.forEach((relatedBrands, brand) => {
        flatMapObject[brand] = Array.from(relatedBrands)
    })

    const uniqueRows = getUniqueRows(flatMapObject)

    return uniqueRows
}

async function getPharmacyItems(countryCode: countryCodes, source: sources, versionKey: string, mustExist = true) {
    const finalProducts = items
    return finalProducts
}

export function checkBrandIsSeparateTerm(input: string, brand: string): boolean {
    // Escape any special characters in the brand name for use in a regular expression
    const escapedBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

    // Check if the brand is at the beginning or end of the string
    const atBeginningOrEnd = new RegExp(
        `^(?:${escapedBrand}\\s|.*\\s${escapedBrand}\\s.*|.*\\s${escapedBrand})$`,
        "i"
    ).test(input)

    // Check if the brand is a separate term in the string
    const separateTerm = new RegExp(`\\b${escapedBrand}\\b`, "i").test(input)

    // The brand should be at the beginning, end, or a separate term
    return atBeginningOrEnd || separateTerm
}

export async function assignBrandIfKnown(countryCode: countryCodes, source: sources, job?: Job) {
    const context = { scope: "assignBrandIfKnown" } as ContextType

    const brandsMapping = await getBrandsMapping()

    const versionKey = "assignBrandIfKnown"
    let products = await getPharmacyItems(countryCode, source, versionKey, false)
    let counter = 0
    const resultData = []
    for (let product of products) {
        counter++

        if (product.m_id) {
            // Already exists in the mapping table, probably no need to update
            continue
        }

        let matchedBrands = []
        for (const brandKey in brandsMapping) {
            const relatedBrands = brandsMapping[brandKey]
            for (const brand of relatedBrands) {
                if (matchedBrands.includes(brand) || WORDS_TO_IGNORE.includes(brand.toUpperCase())) {
                    continue
                }
                const isBrandMatch = checkBrandIsSeparateTerm(product.title, brand)
                if (isBrandMatch) {
                    if(brand === CAPITALIZED && product.title.toUpperCase().contains(CAPITALIZED) && !product.title.contains(CAPITALIZED)) {
                        continue
                    }
                    if (
                        ![...FRONT_WORDS, ...FRONT_OR_SECOND_WORDS].includes(brand) ||
                        FRONT_WORDS.some((word) =>
                          product.title?.toLowerCase().startsWith(word)
                        ) ||
                        FRONT_OR_SECOND_WORDS.some(
                          (word) =>
                            product.title?.toLowerCase().startsWith(word) ||
                            getWordsArray(product.title)?.[1] === word
                        )
                      ) {
                        // Removed accent from brand name
                        matchedBrands.push(deburr(brand))
                      }
                }
            }
            if (matchedBrands.length > 1) {
                matchedBrands.sort(
                (a, b) => product.title?.indexOf(a) - product.title?.indexOf(b))
            }
        }

        const sourceId = product.source_id
        const meta = { matchedBrands }
        const brand = matchedBrands.length ? matchedBrands[0] : null

        const key = `${source}_${countryCode}_${sourceId}`
        const uuid = stringToHash(key)

        // Then brand is inserted into product mapping table
        resultData.push({
            key,
            brand,
            data: `${product.title} -> ${_.uniq(matchedBrands)}`
        })
    }
    const outputDir = path.resolve(__dirname, '..', '..', 'output')
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir)
    }
    const outputFile = path.join(outputDir, `brand_mapping_${source}_${countryCode}.json`)
    fs.writeFileSync(outputFile, JSON.stringify(resultData))
}
