// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/**
 * @title ERC721Mock
 * @notice Simple ERC-721 for testing NftMarketplace
 */
contract ERC721Mock is ERC721 {
    uint256 private _nextTokenId;

    constructor() ERC721("Axync Test NFT", "ATNFT") {}

    function mint(address to) external returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        _mint(to, tokenId);
    }

    function mintBatch(address to, uint256 count) external returns (uint256 firstId) {
        firstId = _nextTokenId;
        for (uint256 i = 0; i < count; i++) {
            _mint(to, _nextTokenId++);
        }
    }
}
