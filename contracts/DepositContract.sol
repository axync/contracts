// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract DepositContract is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    event Deposit(
        address indexed user,
        uint256 indexed assetId,
        uint256 amount,
        bytes32 indexed txHash
    );

    mapping(uint256 => address) public assetAddresses;
    mapping(bytes32 => bool) public processedDeposits;

    constructor() Ownable(msg.sender) {}

    function registerAsset(uint256 assetId, address tokenAddress) external onlyOwner {
        require(tokenAddress != address(0), "Invalid token address");
        assetAddresses[assetId] = tokenAddress;
    }

    function deposit(uint256 assetId, uint256 amount) external nonReentrant {
        // Security: Input validation
        require(amount > 0, "Amount must be greater than 0");
        require(assetId > 0, "Invalid asset ID");
        require(msg.sender != address(0), "Invalid sender");
        
        address tokenAddress = assetAddresses[assetId];
        require(tokenAddress != address(0), "Asset not registered");
        
        bytes32 txHash = keccak256(
            abi.encodePacked(
                msg.sender,
                assetId,
                amount,
                block.timestamp,
                block.number,
                blockhash(block.number - 1)
            )
        );
        
        require(!processedDeposits[txHash], "Deposit already processed");
        processedDeposits[txHash] = true;
        
        IERC20 token = IERC20(tokenAddress);
        token.safeTransferFrom(msg.sender, address(this), amount);
        
        emit Deposit(msg.sender, assetId, amount, txHash);
    }

    function depositNative(uint256 assetId) external payable nonReentrant {
        // Security: Input validation
        require(msg.value > 0, "Amount must be greater than 0");
        require(assetId > 0, "Invalid asset ID");
        require(msg.sender != address(0), "Invalid sender");
        require(assetAddresses[assetId] == address(0), "Use ERC20 deposit for this asset");
        
        bytes32 txHash = keccak256(
            abi.encodePacked(
                msg.sender,
                assetId,
                msg.value,
                block.timestamp,
                block.number,
                blockhash(block.number - 1)
            )
        );
        
        require(!processedDeposits[txHash], "Deposit already processed");
        processedDeposits[txHash] = true;
        
        emit Deposit(msg.sender, assetId, msg.value, txHash);
    }

    function withdrawTokens(address tokenAddress, uint256 amount) external onlyOwner {
        require(tokenAddress != address(0), "Invalid token address");
        IERC20 token = IERC20(tokenAddress);
        token.safeTransfer(owner(), amount);
    }

    function withdrawNative(uint256 amount) external onlyOwner {
        require(address(this).balance >= amount, "Insufficient balance");
        (bool success, ) = payable(owner()).call{value: amount}("");
        require(success, "Transfer failed");
    }

    receive() external payable {
        revert("Use depositNative function");
    }
}
